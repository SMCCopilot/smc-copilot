import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import { ApiProblemError } from '../common/problem.js';
import { ENV, SQL } from '../config/tokens.js';
import { AccountService } from './account.service.js';

/**
 * Account deletion (U16). A request blocks the account at once and starts a grace period in which it can be cancelled;
 * after that a purge removes the workspace and everything under it, the profile and the sign-in record, and scrubs the
 * few rows that must outlive the user (the audit trail, AI call metadata) of anything that identifies them.
 * The whole thing runs well inside the 30 days the beta promises.
 */
@Injectable()
export class DeletionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Deletion');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
    private readonly accounts: AccountService,
  ) {}

  onModuleInit(): void {
    if (!this.sql || this.env.ACCOUNT_PURGE_INTERVAL_MIN <= 0) return;
    this.timer = setInterval(() => {
      this.purgeDue().catch((e: unknown) => this.log.error(`purge failed: ${String(e)}`));
    }, this.env.ACCOUNT_PURGE_INTERVAL_MIN * 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private get db(): Sql {
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sql;
  }

  /** Marks the account deleted, closes everything that is open, and unlinks wallets so they cannot sign in to it. */
  async request(
    userId: string,
    workspaceId: string,
    ip: string | null,
  ): Promise<{ purgeAfter: string }> {
    await this.db.begin(async (tx) => {
      const db = tx as unknown as Sql;
      await db`update profiles set deleted_at = coalesce(deleted_at, now()) where id = ${userId}`;
      await db`update wallet_identities set unlinked_at = coalesce(unlinked_at, now()) where user_id = ${userId}`;
      await db`update copilot_sessions set state = 'ENDED', ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'ACCOUNT_DELETED')
                where user_id = ${userId} and state <> 'ENDED'`;
      await db`update gate_decisions set action = 'VOIDED', decided_at = now(), void_reason = 'ACCOUNT_DELETED'
                where user_id = ${userId} and action = 'ISSUED'`;
      await this.accounts.audit(userId, workspaceId, 'account.delete_request', null, ip, {}, db);
    });
    const [p] = await this.db<{ at: Date }[]>`
      select deleted_at + ${this.env.ACCOUNT_DELETION_GRACE_HOURS} * interval '1 hour' as at from profiles where id = ${userId}`;
    return { purgeAfter: (p?.at ?? new Date()).toISOString() };
  }

  /** Cancels a pending deletion while it is still inside the grace period. Wallets stay unlinked: the user links again. */
  async cancel(userId: string, ip: string | null): Promise<void> {
    const r = await this.db`
      update profiles set deleted_at = null
       where id = ${userId} and deleted_at is not null
         and deleted_at > now() - ${this.env.ACCOUNT_DELETION_GRACE_HOURS} * interval '1 hour'
      returning id`;
    if (r.length === 0)
      throw new ApiProblemError('NOT_FOUND', 'There is no pending deletion to cancel.');
    await this.accounts.audit(userId, null, 'account.delete_cancel', null, ip, {});
  }

  /** Purges every account whose grace period has ended. Returns how many were removed. */
  async purgeDue(limit = 50): Promise<number> {
    const due = await this.db<{ id: string }[]>`
      select id from profiles
       where deleted_at is not null and deleted_at <= now() - ${this.env.ACCOUNT_DELETION_GRACE_HOURS} * interval '1 hour'
       order by deleted_at limit ${limit}`;
    let n = 0;
    for (const { id } of due) {
      // One failing account must not hold back the ones behind it.
      try {
        if (await this.purge(id)) n++;
      } catch (e) {
        this.log.error(`purge of one account failed: ${String(e)}`);
      }
    }
    return n;
  }

  /** Removes one user and everything that identifies them. Safe to repeat. */
  async purge(userId: string): Promise<boolean> {
    const ref = createHash('sha256')
      .update(`${this.env.ABUSE_HASH_SALT ?? 'dev-salt'}:${userId}`)
      .digest('hex')
      .slice(0, 16);
    return this.db.begin(async (tx) => {
      const db = tx as unknown as Sql;
      // Lock the row and re-check it: a cancel that arrived after the list was read, or another purge, wins.
      const still = await db`
        select 1 from profiles
         where id = ${userId} and deleted_at is not null
           and deleted_at <= now() - ${this.env.ACCOUNT_DELETION_GRACE_HOURS} * interval '1 hour'
           for update`;
      if (still.length === 0) return false;
      const ws = (
        await db<{ id: string }[]>`select id from workspaces where owner_id = ${userId}`
      ).map((w) => w.id);
      // Rows that must outlive the user lose everything that points at them.
      await db`update ai_calls set user_id = null, workspace_id = null, session_id = null where user_id = ${userId} or workspace_id = any(${ws})`;
      await db`update audit_log set actor_id = null, ip = null where actor_id = ${userId}`;
      await db`update audit_log set workspace_id = null, ip = null where workspace_id = any(${ws})`;
      await db`update audit_log set target = null where target = ${userId} or target = any(${ws})`;
      await db`update audit_log set detail = '{"scrubbed":true}'::jsonb where detail::text like ${`%${userId}%`} or detail::text like any(${ws.map((w) => `%${w}%`)})`;
      await db`delete from user_feedback where user_id = ${userId}`;
      // The workspace owns almost everything (sessions, trades, journal, chat, explain, voice, gates, notifications).
      if (ws.length > 0) await db`delete from workspaces where id = any(${ws})`;
      await db`delete from auth.users where id = ${userId}`;
      await db`insert into audit_log (action, target, detail) values ('account.purged', ${ref}, '{}'::jsonb)`;
      return true;
    });
  }
}
