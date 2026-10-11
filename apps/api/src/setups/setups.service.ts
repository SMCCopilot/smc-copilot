import { Inject, Injectable } from '@nestjs/common';
import type { SetupDto, TradePlan, TradePlanDto } from '@smc/contracts';
import { HistoricalStatSchema } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { ApiProblemError } from '../common/problem.js';
import { SQL } from '../config/tokens.js';
import { type InstrumentForRisk, RiskService } from '../risk/risk.service.js';

interface SetupRow {
  id: string;
  setup_key: string;
  strategy_version_id: string;
  instrument_id: string;
  canonical: string;
  base: string;
  market_type: 'SPOT' | 'PERP';
  lot_size: string;
  template: 'T1' | 'T2' | 'T3';
  direction: 'LONG' | 'SHORT';
  entry_tf: SetupDto['entryTf'];
  bias_tf: SetupDto['biasTf'];
  state: SetupDto['state'];
  grade: 'A' | 'B' | 'C' | null;
  score: string | null;
  reason_codes: string[];
  components: { kind: string; id: string }[];
  created_at: Date;
  updated_at: Date;
  plan_id: string | null;
  plan_version: number | null;
  plan_hash: string | null;
  plan: TradePlan | null;
}

const LABELS: Record<string, string> = {
  CHOCH: 'Change of character',
  BOS: 'Break of structure',
  SWEEP: 'Liquidity sweep',
  POOL: 'Liquidity pool',
  OB: 'Order block',
  FVG: 'Fair value gap',
  RANGE: 'Dealing range',
};

const SELECT = `
  s.id, s.setup_key, s.strategy_version_id, s.instrument_id, i.canonical, i.base, i.market_type, i.lot_size,
  s.template, s.direction, s.entry_tf, s.bias_tf, s.state, s.grade, s.score, s.reason_codes, s.components,
  s.created_at, coalesce(s.closed_at, s.triggered_at, s.armed_at, s.created_at) as updated_at,
  p.id as plan_id, p.plan_version, p.plan_hash, p.plan`;

export interface SetupFilters {
  instrumentId?: string | undefined;
  state?: string | undefined;
  template?: string | undefined;
  grade?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export const encodeCursor = (at: Date, id: string): string =>
  Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
export function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  const d = new Date(at ?? '');
  if (!id || Number.isNaN(d.getTime())) {
    throw new ApiProblemError('VALIDATION_FAILED', 'The cursor is not valid.');
  }
  return { at: d, id };
}

@Injectable()
export class SetupsService {
  constructor(
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
    private readonly risk: RiskService,
  ) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  private async toDto(r: SetupRow, workspaceId: string | null): Promise<SetupDto> {
    const live = r.state === 'ARMED' || r.state === 'TRIGGERED';
    let plan: TradePlanDto | null = null;
    if (live && r.plan && r.plan_id && r.plan_version !== null && r.plan_hash) {
      let riskBlock: TradePlanDto['risk'] = null;
      if (workspaceId) {
        const profile = await this.risk.getProfile(workspaceId);
        if (profile.balance !== null) {
          const inst: InstrumentForRisk = {
            marketType: r.market_type,
            lotSize: Number(r.lot_size),
            baseAsset: r.base,
          };
          const c = this.risk.check(
            profile,
            {
              direction: r.plan.direction,
              refPrice: r.plan.entry.refPrice,
              stop: r.plan.stop.price,
            },
            inst,
          );
          riskBlock = {
            units: c.positionSize?.units ?? null,
            riskAmount: c.positionSize?.riskAmount ?? null,
            notional: c.positionSize?.notional ?? null,
            liquidationPrice: c.liquidationPrice ?? null,
            warnings: c.warnings,
          };
        }
      }
      plan = {
        planId: r.plan_id,
        planVersion: r.plan_version,
        planHash: r.plan_hash,
        direction: r.plan.direction,
        entry: {
          top: r.plan.entry.top,
          bottom: r.plan.entry.bottom,
          refPrice: r.plan.entry.refPrice,
          basis: r.plan.entry.refBasis,
        },
        stop: { price: r.plan.stop.price, basis: r.plan.stop.basis },
        targets: r.plan.targets,
        invalidation: r.plan.invalidation,
        scenarios: r.plan.scenarios,
        assumptions: {
          spread: r.plan.assumptions.spread,
          slippage: r.plan.assumptions.slippage,
          feeBps: r.plan.assumptions.feeBps,
        },
        risk: riskBlock,
        warnings:
          riskBlock?.warnings.filter(
            (w) => w === 'LIQUIDATION_BEFORE_STOP' || w === 'CORRELATED_EXPOSURE',
          ) ?? [],
        disclaimers: r.plan.disclaimers,
      };
    }
    const stats = r.plan?.stats ? HistoricalStatSchema.safeParse(r.plan.stats) : null;
    const historical = stats?.success ? stats.data : null;
    return {
      id: r.id,
      template: r.template,
      direction: r.direction,
      instrumentId: r.instrument_id,
      canonical: r.canonical,
      entryTf: r.entry_tf,
      biasTf: r.bias_tf,
      state: r.state,
      grade: r.grade,
      score: r.score === null ? null : Number(r.score),
      reasonCodes: r.reason_codes,
      components: r.components.map((c) => ({
        kind: c.kind,
        id: c.id,
        label: LABELS[c.kind] ?? c.kind,
      })),
      plan,
      historical,
      historicalReason: historical ? null : 'INSUFFICIENT_HISTORY',
      confidence: historical ? (r.plan?.confidence ?? 'LOW') : 'LOW',
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  /** The base rate is "displayed" when a plan carrying one is read: that is what calibration compares with outcomes. */
  private async recordDisplay(r: SetupRow): Promise<void> {
    const stats = r.plan?.stats;
    if (!stats) return;
    const [c] = await this.sql<{ id: string }[]>`
      select id from cohort_stats
       where strategy_version_id = ${r.strategy_version_id} and asset_class = 'CRYPTO' and segment = 'ALL'
         and template = ${r.template} and grade = ${r.grade} and source = ${stats.source}
         and (direction = ${r.direction} or direction is null)
       order by (direction is null) limit 1`;
    if (!c) return;
    await this.sql`
      insert into setup_displays (setup_id, cohort_id, rate, ci_low, ci_high)
      values (${r.id}, ${c.id}, ${stats.rate}, ${stats.ci95[0]}, ${stats.ci95[1]})
      on conflict (setup_id, cohort_id) do nothing`;
  }

  private base(): ReturnType<Sql['unsafe']> {
    return this.sql.unsafe(`select ${SELECT}
      from setups s join instruments i on i.id = s.instrument_id
      left join lateral (select * from trade_plans tp where tp.setup_id = s.id order by tp.plan_version desc limit 1) p on true`);
  }

  async list(
    workspaceId: string,
    f: SetupFilters,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: SetupDto[]; nextCursor: string | null }> {
    const cur = decodeCursor(cursor);
    const sql = this.sql;
    const rows = await sql<SetupRow[]>`
      select ${sql.unsafe(SELECT)}
        from setups s join instruments i on i.id = s.instrument_id
        left join lateral (select * from trade_plans tp where tp.setup_id = s.id order by tp.plan_version desc limit 1) p on true
       where true
         ${f.instrumentId ? sql`and s.instrument_id = ${f.instrumentId}` : sql``}
         ${f.state ? sql`and s.state = ${f.state}` : sql``}
         ${f.template ? sql`and s.template = ${f.template}` : sql``}
         ${f.grade ? sql`and s.grade = ${f.grade}` : sql``}
         ${f.from ? sql`and s.created_at >= ${f.from}` : sql``}
         ${f.to ? sql`and s.created_at < ${f.to}` : sql``}
         ${cur ? sql`and (s.created_at, s.id) < (${cur.at}, ${cur.id})` : sql``}
       order by s.created_at desc, s.id desc
       limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await Promise.all(page.map((r) => this.toDto(r, workspaceId))),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async get(id: string, workspaceId: string): Promise<SetupDto> {
    const sql = this.sql;
    const [r] = await sql<SetupRow[]>`
      select ${sql.unsafe(SELECT)}
        from setups s join instruments i on i.id = s.instrument_id
        left join lateral (select * from trade_plans tp where tp.setup_id = s.id order by tp.plan_version desc limit 1) p on true
       where s.id = ${id}`;
    if (!r) throw new ApiProblemError('NOT_FOUND');
    await this.recordDisplay(r);
    return this.toDto(r, workspaceId);
  }

  async history(id: string) {
    const [s] = await this.sql<{ id: string }[]>`select id from setups where id = ${id}`;
    if (!s) throw new ApiProblemError('NOT_FOUND');
    const rows = await this.sql<
      { from_state: string | null; to_state: string; at_candle: Date; reason_codes: string[] }[]
    >`
      select from_state, to_state, at_candle, reason_codes from setup_transitions where setup_id = ${id} order by at_candle, id`;
    return {
      items: rows.map((r) => ({
        from: r.from_state,
        to: r.to_state,
        at: r.at_candle.toISOString(),
        reasonCodes: r.reason_codes,
      })),
    };
  }

  /** "Why nothing?": setups the hard filters rejected, newest first, with their reason codes. */
  async rejected(
    workspaceId: string,
    instrumentId: string | undefined,
    from: Date | undefined,
    limit: number,
  ) {
    const r = await this.list(
      workspaceId,
      { instrumentId, state: 'REJECTED', from },
      undefined,
      limit,
    );
    return { items: r.items };
  }

  /** Live setups for one instrument (what the analysis snapshot shows). */
  async activeFor(instrumentId: string, workspaceId: string): Promise<SetupDto[]> {
    const sql = this.sql;
    const rows = await sql<SetupRow[]>`
      select ${sql.unsafe(SELECT)}
        from setups s join instruments i on i.id = s.instrument_id
        left join lateral (select * from trade_plans tp where tp.setup_id = s.id order by tp.plan_version desc limit 1) p on true
       where s.instrument_id = ${instrumentId} and s.state in ('ARMED', 'TRIGGERED')
       order by s.created_at desc limit 50`;
    return Promise.all(rows.map((r) => this.toDto(r, workspaceId)));
  }

  async cohorts(includeAll: boolean) {
    const rows = await this.sql<
      {
        template: string;
        grade: string;
        direction: string | null;
        source: string;
        window_from: Date;
        window_to: Date;
        n: number;
        wins: number;
        rate: string;
        ci_low: string;
        ci_high: string;
        avg_r: string | null;
        sufficient: boolean;
        status: string;
      }[]
    >`
      select c.template, c.grade, c.direction, c.source, c.window_from, c.window_to, c.n, c.wins, c.rate, c.ci_low, c.ci_high,
             c.avg_r, c.sufficient, c.status
        from cohort_stats c join strategy_versions v on v.id = c.strategy_version_id and v.status = 'ACTIVE'
       ${includeAll ? this.sql`` : this.sql`where c.sufficient and c.status = 'ACTIVE'`}
       order by c.template, c.grade, c.source`;
    return {
      items: rows.map((r) => ({
        template: r.template,
        grade: r.grade,
        direction: r.direction,
        source: r.source,
        n: r.n,
        // A rate leaves the server only for a sufficient cohort, whatever the caller asked for.
        rate: r.sufficient ? Number(r.rate) : null,
        ci95: r.sufficient ? [Number(r.ci_low), Number(r.ci_high)] : null,
        avgR: r.sufficient && r.avg_r !== null ? Number(r.avg_r) : null,
        sufficient: r.sufficient,
        status: r.status,
        window: { from: r.window_from.toISOString(), to: r.window_to.toISOString() },
        disclaimerKey: 'HISTORICAL_NOT_FORECAST',
      })),
    };
  }
}
