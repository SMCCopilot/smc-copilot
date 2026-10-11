import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Env } from '@smc/config';
import { AiProviderIdSchema, AiProviderPatchSchema } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { z } from 'zod';
import { AccountService } from '../account/account.service.js';
import { FlagsService } from '../account/flags.service.js';
import { AdminGuard, adminSourceIp } from '../admin/admin.guard.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { ENV, SQL } from '../config/tokens.js';
import { NarrativeService } from './narrative.service.js';
import { ProviderConfigService, providerFlagKey } from './provider-config.service.js';

const CostsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

/** Owner controls for the AI layer: which providers are active, and what AI is costing. Every change is audited. */
@Controller('v1/admin/ai')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AiAdminController {
  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
    private readonly providers: ProviderConfigService,
    private readonly flags: FlagsService,
    private readonly account: AccountService,
    private readonly narratives: NarrativeService,
  ) {}

  private get db(): Sql {
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sql;
  }

  /** Never returns a key; only whether one is present. */
  @Get('providers')
  async list() {
    return { items: await this.providers.views() };
  }

  /** Switch a provider on or off, change its order, or change which data classes it may see. Effective within seconds. */
  @Put('providers/:id')
  async patch(@Req() req: AuthenticatedRequest, @Param('id') rawId: string, @Body() body: unknown) {
    const id = parseWith(AiProviderIdSchema, rawId);
    const patch = parseWith(AiProviderPatchSchema, body);
    const key = providerFlagKey(id);
    const current = (await this.providers.views()).find((v) => v.id === id);
    const row = await this.flags.row(key);
    const rules = {
      ...(row?.rules ?? {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.dataClasses !== undefined ? { dataClasses: patch.dataClasses } : {}),
    };
    const enabled = patch.enabled ?? current?.enabled ?? false;
    await this.db`
      insert into feature_flags (key, enabled, rollout_pct, rules, updated_at)
      values (${key}, ${enabled}, 100, ${this.db.json(rules as never)}, now())
      on conflict (key) do update set enabled = excluded.enabled, rules = excluded.rules, updated_at = now()`;
    this.flags.invalidate();
    await this.account.audit(
      req.principal.userId,
      null,
      'admin.ai_provider',
      id,
      adminSourceIp(req, this.env.TRUST_PROXY_HEADERS) || null,
      { enabled, ...rules },
    );
    return (await this.providers.views()).find((v) => v.id === id);
  }

  /** Today's spend against the global cap, by job, and the shared-narrative cache counters. */
  @Get('spend')
  async spend() {
    const [g] = await this.db<
      { cost_usd: string; calls: number; cap_usd: string; tripped_at: Date | null }[]
    >`
      select cost_usd, calls, cap_usd, tripped_at from ai_global_ledger where day = (now() at time zone 'utc')::date`;
    const byJob = await this.db<{ job: string; calls: number; cost: string }[]>`
      select job, count(*)::int as calls, coalesce(sum(cost_usd), 0) as cost
        from ai_calls where created_at >= date_trunc('day', now() at time zone 'utc')
       group by job order by 3 desc`;
    return {
      day: new Date().toISOString().slice(0, 10),
      costUsd: Number(g?.cost_usd ?? 0),
      calls: g?.calls ?? 0,
      capUsd: Number(g?.cap_usd ?? this.env.AI_GLOBAL_DAILY_CAP_USD),
      tripped: Boolean(g?.tripped_at),
      byJob: byJob.map((j) => ({ job: j.job, calls: j.calls, costUsd: Number(j.cost) })),
      narrativeCache: this.narratives.stats,
    };
  }

  /** Cost by day, job, provider and model: the basis for cost per session-hour. */
  @Get('costs')
  async costs(@Query() raw: unknown) {
    const { days } = parseWith(CostsQuery, raw);
    const rows = await this.db<
      {
        day: string;
        job: string;
        provider: string;
        model: string;
        calls: number;
        cost: string;
        tin: string;
        tout: string;
        p95: number | null;
      }[]
    >`
      select to_char(created_at at time zone 'utc', 'YYYY-MM-DD') as day, job, provider, model,
             count(*)::int as calls, coalesce(sum(cost_usd), 0) as cost,
             coalesce(sum(tokens_in), 0) as tin, coalesce(sum(tokens_out), 0) as tout,
             percentile_disc(0.95) within group (order by latency_ms) as p95
        from ai_calls
       where created_at >= now() - ${days} * interval '1 day' and outcome <> 'PROVIDER_BLOCKED_BY_POLICY'
       group by 1, 2, 3, 4 order by 1 desc, 6 desc`;
    return {
      items: rows.map((r) => ({
        day: r.day,
        job: r.job,
        provider: r.provider,
        model: r.model,
        calls: r.calls,
        costUsd: Number(r.cost),
        tokensIn: Number(r.tin),
        tokensOut: Number(r.tout),
        p95LatencyMs: r.p95,
      })),
    };
  }
}
