import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { CallOutcome, CallRecord } from '@smc/ai';
import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import { ENV, SQL } from '../config/tokens.js';
import { currentAiContext } from './ai.context.js';

const ENSURE_EVERY_MS = 6 * 3_600_000;

/**
 * The cost ledger (A05 section 9.3). Every provider attempt is written to `ai_calls`; spend is added to the
 * workspace's daily ledger and to the global daily ledger, and the global cap trips automatically when reached.
 * Prompts and answers are never stored here, only tokens, cost, latency and outcome.
 */
@Injectable()
export class AiMeterService implements OnModuleInit {
  private readonly log = new Logger('AiMeter');
  private lastEnsure = 0;

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensurePartitions().catch((e: unknown) =>
      this.log.warn(`partition check failed: ${String(e)}`),
    );
  }

  /** Makes sure this month's and next month's `ai_calls` partitions exist, so an insert never fails for want of one. */
  private async ensurePartitions(): Promise<void> {
    if (!this.sql) return;
    const now = Date.now();
    if (now - this.lastEnsure < ENSURE_EVERY_MS) return;
    this.lastEnsure = now;
    await this.sql`select ensure_ai_calls_partition(date_trunc('month', now())::date)`;
    await this
      .sql`select ensure_ai_calls_partition(date_trunc('month', now() + interval '1 month')::date)`;
  }

  /** The `onCall` hook for the router. Never throws: a ledger fault is logged, not allowed to break an answer. */
  readonly onCall = async (r: CallRecord): Promise<void> => {
    if (!this.sql) return;
    try {
      await this.ensurePartitions();
      const ctx = currentAiContext();
      await this.sql`
        insert into ai_calls (id, workspace_id, user_id, session_id, correlation_id, job, data_class, provider, model,
                              prompt_version, facts_hash, tokens_in, tokens_out, tokens_cached_in, tokens_cache_write,
                              cost_usd, latency_ms, outcome, error_code)
        values (${r.id}, ${ctx?.workspaceId ?? null}, ${ctx?.userId ?? null}, ${ctx?.sessionId ?? null},
                ${ctx?.correlationId ?? null}, ${r.job}, ${r.dataClass}, ${r.provider}, ${r.model},
                ${ctx?.promptVersion ?? 'unknown'}, ${ctx?.factsHash ?? null}, ${r.usage.tokensIn}, ${r.usage.tokensOut},
                ${r.usage.cachedIn}, ${r.usage.cacheWrite}, ${r.costUsd}, ${r.latencyMs}, ${r.outcome}, ${r.errorCode ?? null})`;
      if (r.costUsd > 0) await this.charge(ctx?.workspaceId ?? null, r.costUsd);
    } catch (e) {
      this.log.error(`ledger write failed: ${String(e)}`);
    }
  };

  readonly onOutcome = async (
    callId: string,
    outcome: CallOutcome,
    detail?: string,
  ): Promise<void> => {
    if (!this.sql) return;
    try {
      // The creation-time bound lets Postgres prune to the current partitions.
      await this.sql`
        update ai_calls set outcome = ${outcome}, error_code = coalesce(${detail?.slice(0, 120) ?? null}, error_code)
         where id = ${callId} and created_at > now() - interval '1 hour'`;
    } catch (e) {
      this.log.error(`outcome update failed: ${String(e)}`);
    }
  };

  private async charge(workspaceId: string | null, usd: number): Promise<void> {
    const sql = this.sql as Sql;
    if (workspaceId) {
      await sql`
        insert into ai_budget_ledger (workspace_id, day, cost_usd, calls)
        values (${workspaceId}, (now() at time zone 'utc')::date, ${usd}, 1)
        on conflict (workspace_id, day) do update
          set cost_usd = ai_budget_ledger.cost_usd + excluded.cost_usd, calls = ai_budget_ledger.calls + 1`;
    }
    const [g] = await sql<{ cost_usd: string; cap_usd: string; tripped_at: Date | null }[]>`
      insert into ai_global_ledger (day, cost_usd, calls, cap_usd)
      values ((now() at time zone 'utc')::date, ${usd}, 1, ${this.env.AI_GLOBAL_DAILY_CAP_USD})
      on conflict (day) do update
        set cost_usd = ai_global_ledger.cost_usd + excluded.cost_usd, calls = ai_global_ledger.calls + 1
      returning cost_usd, cap_usd, tripped_at`;
    if (g && g.tripped_at === null && Number(g.cost_usd) >= Number(g.cap_usd)) {
      const [t] = await sql`
        update ai_global_ledger set tripped_at = now()
         where day = (now() at time zone 'utc')::date and tripped_at is null returning day`;
      if (t) {
        await sql`
          insert into audit_log (actor_id, workspace_id, action, target, detail)
          values (null, null, 'ai.global_cap_tripped', ${String(t.day)}, ${sql.json({ capUsd: Number(g.cap_usd) })})`;
        this.log.error(
          `global AI spend cap reached (${g.cap_usd} USD): AI features fall back to templates until the next UTC day`,
        );
      }
    }
  }
}
