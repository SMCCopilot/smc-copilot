import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@smc/config';
import type { BudgetState, KillSwitchScope } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { FlagsService } from '../account/flags.service.js';
import { ApiProblemError } from '../common/problem.js';
import { ENV, SQL } from '../config/tokens.js';

export const SOFT_FRACTION = 0.8;

export type GateVerdict =
  | { allowed: true; soft: boolean; budget: BudgetState | null }
  | {
      allowed: false;
      reason: 'KILL_SWITCH' | 'GLOBAL_CAP' | 'USER_BUDGET';
      budget: BudgetState | null;
    };

const nextMidnightUtc = (): string => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};

/**
 * Spend controls in front of every model call (invariant 11): the kill switches, the global daily cap, and the
 * per-workspace daily budget with a soft limit (cheaper model) and a hard limit (feature off, templates remain).
 */
@Injectable()
export class AiGateService {
  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
    private readonly flags: FlagsService,
  ) {}

  async globalTripped(): Promise<boolean> {
    if (!this.sql) return false;
    const [g] = await this.sql<{ tripped_at: Date | null }[]>`
      select tripped_at from ai_global_ledger where day = (now() at time zone 'utc')::date`;
    return Boolean(g?.tripped_at);
  }

  async budget(workspaceId: string): Promise<BudgetState> {
    if (!this.sql) {
      return { spentUsd: 0, limitUsd: 0, state: 'OK', resetsAt: nextMidnightUtc() };
    }
    const [row] = await this.sql<{ spent: string | null; lim: string | null }[]>`
      select (select cost_usd from ai_budget_ledger where workspace_id = ${workspaceId} and day = (now() at time zone 'utc')::date) as spent,
             (select limits->>'daily_ai_budget_usd' from entitlements where workspace_id = ${workspaceId}) as lim`;
    const spentUsd = Number(row?.spent ?? 0);
    const limitUsd = row?.lim != null ? Number(row.lim) : this.env.AI_DAILY_BUDGET_DEFAULT_USD;
    const state =
      spentUsd >= limitUsd ? 'HARD' : spentUsd >= limitUsd * SOFT_FRACTION ? 'SOFT' : 'OK';
    return { spentUsd, limitUsd, state, resetsAt: nextMidnightUtc() };
  }

  /**
   * `scopes` are the kill switches that must all be off. With a workspace the user budget applies as well; without one
   * (shared narratives) only the switches and the global cap do.
   */
  async check(scopes: readonly KillSwitchScope[], workspaceId?: string): Promise<GateVerdict> {
    for (const s of scopes) {
      if (await this.flags.killed(s))
        return { allowed: false, reason: 'KILL_SWITCH', budget: null };
    }
    if (await this.globalTripped()) return { allowed: false, reason: 'GLOBAL_CAP', budget: null };
    if (!workspaceId) return { allowed: true, soft: false, budget: null };
    const budget = await this.budget(workspaceId);
    if (budget.state === 'HARD') return { allowed: false, reason: 'USER_BUDGET', budget };
    return { allowed: true, soft: budget.state === 'SOFT', budget };
  }

  /** For REST routes: turns a refusal into the catalogue error. */
  async require(
    scopes: readonly KillSwitchScope[],
    workspaceId: string,
  ): Promise<{ soft: boolean; budget: BudgetState | null }> {
    const v = await this.check(scopes, workspaceId);
    if (v.allowed) return v;
    if (v.reason === 'USER_BUDGET') {
      throw new ApiProblemError(
        'BUDGET_EXCEEDED',
        'Your daily AI allowance is used up. It resets at midnight UTC.',
      );
    }
    if (v.reason === 'KILL_SWITCH') {
      throw new ApiProblemError('KILL_SWITCH_ACTIVE', 'This feature is temporarily switched off.');
    }
    throw new ApiProblemError('AI_TEMPORARILY_UNAVAILABLE', 'AI features are paused for today.');
  }
}
