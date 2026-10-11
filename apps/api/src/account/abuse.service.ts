import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import { ENV, SQL } from '../config/tokens.js';
import { RateLimiter } from './rate-limit.js';

export type AbuseSubject = 'IP_HASH' | 'DEVICE_HASH' | 'USER' | 'WALLET';

/**
 * Abuse counters keyed by SALTED hashes, never raw addresses (A08 section 2, table `abuse_flags`). A temporary block
 * is a row with an expiry; checking is one indexed read.
 */
@Injectable()
export class AbuseService {
  private readonly failures = new RateLimiter();

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Salted hash. Without a salt (development only) a fixed string is used so tests are deterministic. */
  hash(value: string): string {
    return createHash('sha256')
      .update(`${this.env.ABUSE_HASH_SALT ?? 'dev-salt'}:${value}`)
      .digest('hex');
  }

  async isBlocked(kind: AbuseSubject, value: string): Promise<boolean> {
    if (!this.sql) return false;
    const [row] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from abuse_flags
       where subject_kind = ${kind} and subject_key = ${this.hash(value)} and expires_at > now()`;
    return (row?.n ?? 0) > 0;
  }

  async flag(kind: AbuseSubject, value: string, reason: string, minutes: number): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      insert into abuse_flags (subject_kind, subject_key, reason, expires_at)
      values (${kind}, ${this.hash(value)}, ${reason}, now() + ${minutes} * interval '1 minute')`;
  }

  /**
   * Counts a failed attempt. After `limit` failures inside the window the subject is flagged for `blockMinutes`
   * and the caller is told to stop (true).
   */
  async recordFailure(
    kind: AbuseSubject,
    value: string,
    reason: string,
    opts: { limit: number; windowMs: number; blockMinutes: number },
  ): Promise<boolean> {
    const wait = this.failures.hit(
      `${kind}:${reason}:${this.hash(value)}`,
      opts.limit,
      opts.windowMs,
    );
    if (wait === null) return false;
    await this.flag(kind, value, reason, opts.blockMinutes);
    return true;
  }
}
