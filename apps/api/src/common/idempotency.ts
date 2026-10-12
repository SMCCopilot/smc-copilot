import { createHash } from 'node:crypto';
import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import type { Sql } from '@smc/db';
import type { Response } from 'express';
import { from, type Observable } from 'rxjs';
import type { AccountRequest } from '../account/account.guards.js';
import { SQL } from '../config/tokens.js';
import { ApiProblemError } from './problem.js';

const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const WAIT_MS = 3000;
const STALE_SECONDS = 60;

/** JSON with sorted keys, so the same body always hashes the same whatever order the client wrote it in. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * `Idempotency-Key` handling (A07 section 1). The key and a hash of the request are stored for 24 hours per workspace:
 * the same key with the same request returns the stored response (flagged with `Idempotent-Replayed`), the same key
 * with a different request is `IDEMPOTENCY_CONFLICT`, and only successful responses are stored, so a failed attempt can
 * be retried. A concurrent duplicate waits briefly for the first to finish instead of running twice.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private inserts = 0;

  constructor(@Inject(SQL) private readonly sql: Sql | null) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.run(context, next));
  }

  private async run(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const req = context.switchToHttp().getRequest<AccountRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new ApiProblemError(
        'VALIDATION_FAILED',
        'A valid Idempotency-Key header is required.',
        {
          issues: [
            { path: 'Idempotency-Key', code: 'invalid', message: '8-128 letters, digits, - or _' },
          ],
        },
      );
    }
    const workspaceId = req.account.workspaceId;
    const hash = createHash('sha256')
      .update(`${req.method} ${req.route?.path ?? req.path}\n${stableStringify(req.body ?? {})}`)
      .digest('hex');
    const code =
      (Reflect.getMetadata('__httpCode__', context.getHandler()) as number | undefined) ?? 201;

    const inserted = await this.sql`
      insert into idempotency_keys (workspace_id, key, request_hash)
      values (${workspaceId}, ${key}, ${hash})
      on conflict (workspace_id, key) do nothing
      returning key`;

    if (inserted.length === 0) return this.replay(res, workspaceId, key, hash);

    if (++this.inserts % 500 === 0) {
      void this
        .sql`delete from idempotency_keys where created_at < now() - interval '24 hours'`.catch(
        () => {},
      );
    }
    try {
      const body = await next.handle().toPromise();
      await this.sql`
        update idempotency_keys set status = ${code}, response = ${this.sql.json((body ?? null) as never)}
         where workspace_id = ${workspaceId} and key = ${key}`;
      return body;
    } catch (error) {
      await this
        .sql`delete from idempotency_keys where workspace_id = ${workspaceId} and key = ${key}`;
      throw error;
    }
  }

  private async replay(
    res: Response,
    workspaceId: string,
    key: string,
    hash: string,
  ): Promise<unknown> {
    const sql = this.sql as Sql;
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const [row] = await sql<
        { request_hash: string; status: number | null; response: unknown; age: number }[]
      >`
        select request_hash, status, response, extract(epoch from now() - created_at)::int as age
          from idempotency_keys where workspace_id = ${workspaceId} and key = ${key}`;
      if (!row) throw new ApiProblemError('CONFLICT', 'Please retry the request.');
      if (row.request_hash !== hash) {
        throw new ApiProblemError(
          'IDEMPOTENCY_CONFLICT',
          'That key was already used for a different request.',
        );
      }
      if (row.status !== null) {
        res.status(row.status);
        res.setHeader('Idempotent-Replayed', 'true');
        return row.response;
      }
      // A first attempt that never finished (the process died) must not block this key for a whole day.
      if (row.age > STALE_SECONDS) {
        await sql`delete from idempotency_keys where workspace_id = ${workspaceId} and key = ${key} and status is null`;
        throw new ApiProblemError('CONFLICT', 'The earlier attempt did not finish. Please retry.');
      }
      if (Date.now() > deadline)
        throw new ApiProblemError('CONFLICT', 'The first request is still running.');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Requires an Idempotency-Key and gives the route the replay behaviour above. Place after the access decorator. */
export const Idempotent = () => applyDecorators(UseInterceptors(IdempotencyInterceptor));
