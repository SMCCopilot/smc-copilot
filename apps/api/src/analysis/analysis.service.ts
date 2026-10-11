import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  type AnalysisResponse,
  type StrategyConfig,
  TIMEFRAME_MS,
  type Timeframe,
} from '@smc/contracts';
import type { Sql } from '@smc/db';
import {
  buildFacts,
  dealingRange,
  type EngineState,
  STATE_VERSION,
  sessionContext,
  sha1,
  shortId,
} from '@smc/smc-engine';
import { stableStringify } from '../common/idempotency.js';
import { ApiProblemError } from '../common/problem.js';
import { ENGINE_RUNNER, INGEST_RUNTIME, SQL } from '../config/tokens.js';
import type { EngineRunner } from '../engine/engine.runner.js';
import { EngineStore } from '../engine/engine.store.js';
import type { IngestRuntime } from '../ingest/ingest.runtime.js';
import { MarketsService } from '../markets/markets.service.js';
import { SetupsService } from '../setups/setups.service.js';

const STALE_AFTER_MS = 30 * 60_000;
const STRATEGY_TTL_MS = 30_000;
const MAX_SWINGS = 12;

export interface LoadedState {
  state: EngineState;
  cfg: StrategyConfig;
  strategyId: string;
}

const closeOf = (state: EngineState): number =>
  Object.entries(state.lastCandleOpenTime).reduce(
    (m, [tf, open]) => Math.max(m, (open as number) + TIMEFRAME_MS[tf as Timeframe]),
    0,
  );

/** Builds the analysis snapshot (A07 section 4.2) from engine state: the same facts the AI will see, plus UI structure. */
@Injectable()
export class AnalysisService {
  private strategy: { at: number; value: { id: string; config: StrategyConfig } } | null = null;

  constructor(
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
    private readonly markets: MarketsService,
    private readonly setups: SetupsService,
    @Optional() @Inject(ENGINE_RUNNER) private readonly runner: EngineRunner | null,
    @Optional() @Inject(INGEST_RUNTIME) private readonly runtime: IngestRuntime | null,
  ) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  async activeStrategy(): Promise<{ id: string; config: StrategyConfig }> {
    const now = Date.now();
    if (this.strategy && now - this.strategy.at < STRATEGY_TTL_MS) return this.strategy.value;
    const s = await new EngineStore(this.sql).activeStrategy();
    if (!s) throw new ApiProblemError('ANALYSIS_UNAVAILABLE', 'No active strategy version.');
    this.strategy = { at: now, value: { id: s.id, config: s.config } };
    return this.strategy.value;
  }

  /** In-memory state when the engine runs in this process, else the newest stored snapshot. */
  async loadState(instrumentId: string): Promise<LoadedState> {
    const strategy = await this.activeStrategy();
    let state = this.runner?.stateOf(instrumentId);
    if (!state) {
      const snap = await new EngineStore(this.sql).latestSnapshot(instrumentId, strategy.id);
      state = snap?.state;
    }
    if (!state || state.v !== STATE_VERSION) {
      throw new ApiProblemError(
        'ANALYSIS_UNAVAILABLE',
        'The engine has not analysed this instrument yet.',
      );
    }
    return { state, cfg: strategy.config, strategyId: strategy.id };
  }

  /** The engine's facts for one instrument, as the AI layer sees them (and nothing else). */
  async marketFacts(instrumentId: string) {
    const instrument = await this.markets.get(instrumentId);
    if (!instrument) throw new ApiProblemError('NOT_FOUND');
    const { state, cfg } = await this.loadState(instrumentId);
    const asOf = closeOf(state);
    const monitor = this.runtime?.monitor?.statusOf(instrumentId)?.state;
    const dataQuality: AnalysisResponse['dataQuality'] =
      monitor === 'DEGRADED' || monitor === 'STALE'
        ? monitor
        : monitor === 'OK' || Date.now() - asOf <= STALE_AFTER_MS
          ? 'OK'
          : 'STALE';
    return { facts: buildFacts(state, cfg, { asOf, dataQuality }), instrument, asOf };
  }

  async snapshot(
    instrumentId: string,
    workspaceId: string,
    tf: Timeframe | undefined,
    include: ReadonlySet<string>,
  ): Promise<AnalysisResponse> {
    const instrument = await this.markets.get(instrumentId);
    if (!instrument) throw new ApiProblemError('NOT_FOUND');
    const { state, cfg, strategyId } = await this.loadState(instrumentId);
    const asOf = closeOf(state);
    const entryTf = tf ?? cfg.timeframes.entry[cfg.timeframes.entry.length - 1] ?? '15m';
    const monitor = this.runtime?.monitor?.statusOf(instrumentId)?.state;
    const dataQuality: AnalysisResponse['dataQuality'] =
      monitor === 'DEGRADED' || monitor === 'STALE'
        ? monitor
        : monitor === 'OK' || Date.now() - asOf <= STALE_AFTER_MS
          ? 'OK'
          : 'STALE';
    const facts = buildFacts(state, cfg, { asOf, dataQuality });
    const want = (k: string): boolean => include.size === 0 || include.has(k);

    const out: Omit<AnalysisResponse, 'snapshotId'> = {
      asOf: new Date(asOf).toISOString(),
      instrumentId: instrument.canonical,
      strategyVersionId: strategyId,
      dataQuality,
      warnings: facts.warnings,
      htfBias: facts.htfBias,
    };

    const tfState = state.perTf[entryTf];
    if (want('structure') && tfState) {
      const toTime = (open: number): string => new Date(open).toISOString();
      const swings = (['internal', 'external'] as const).flatMap((scale) =>
        tfState[scale].swings.slice(-MAX_SWINGS).map((s) => ({
          id: shortId('E', s.id),
          kind: s.kind,
          scale,
          price: s.level,
          time: toTime(s.barOpenTime),
        })),
      );
      const breaks = (['internal', 'external'] as const).flatMap((scale) => {
        const b = tfState[scale].lastBreak;
        return b
          ? [
              {
                id: shortId('E', b.id),
                scale,
                type: b.type,
                time: toTime(b.time - TIMEFRAME_MS[entryTf]),
              },
            ]
          : [];
      });
      const r = dealingRange(tfState.external, cfg);
      out.structure = {
        tf: entryTf,
        trend: tfState.external.trend,
        internalTrend: tfState.internal.trend,
        swings,
        breaks,
        range: r
          ? {
              low: r.low,
              high: r.high,
              eq: r.eq,
              oteBottom: r.ote.bottom,
              oteTop: r.ote.top,
              trend: r.trend,
            }
          : null,
      };
    }
    if (want('zones')) out.zones = facts.zones;
    if (want('liquidity')) out.liquidity = facts.levels.filter((l) => !l.kind.startsWith('OPEN_'));
    if (want('context')) {
      const c = sessionContext(asOf, cfg);
      out.context = {
        openLevels: facts.levels.filter((l) => l.kind.startsWith('OPEN_')),
        weekend: c.weekend,
        session: c.killzones[0] ?? c.active[c.active.length - 1] ?? 'OFF',
        inKillzone: c.inKillzone,
      };
    }
    if (want('setups')) out.setups = await this.setups.activeFor(instrumentId, workspaceId);

    return { snapshotId: sha1(stableStringify({ ...out, tf: entryTf })).slice(0, 16), ...out };
  }

  /** Engine events (structure breaks, sweeps, zones) for charts and debugging, oldest first. */
  async events(
    instrumentId: string,
    tf: Timeframe | undefined,
    since: Date | undefined,
    limit: number,
  ) {
    if (!(await this.markets.get(instrumentId))) throw new ApiProblemError('NOT_FOUND');
    const rows = await this.sql<
      {
        event_id: string;
        tf: string;
        type: string;
        anchor_time: Date;
        event_time: Date;
        payload: { scale: string | null; data: Record<string, unknown> };
      }[]
    >`
      select event_id, tf, type, anchor_time, event_time, payload from engine_events
       where instrument_id = ${instrumentId} and not retracted and type not like 'SETUP_%' and type <> 'PLAN_READY'
         ${tf ? this.sql`and tf = ${tf}` : this.sql``}
         ${since ? this.sql`and event_time > ${since}` : this.sql``}
       order by event_time desc, event_id limit ${limit}`;
    return {
      items: rows.reverse().map((r) => ({
        id: shortId('E', r.event_id),
        type: r.type,
        tf: r.tf,
        scale: r.payload.scale,
        time: r.event_time.toISOString(),
        anchor: r.anchor_time.toISOString(),
        data: r.payload.data,
      })),
    };
  }
}
