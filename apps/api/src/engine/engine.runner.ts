import { type Candle, type StrategyConfig, TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import type { Sql } from '@smc/db';
import {
  createEngine,
  type EngineEvent,
  type EngineState,
  orderByClose,
  STATE_VERSION,
  type StepOptions,
  step,
} from '@smc/smc-engine';
import type { CandleStore } from '../ingest/candle-store.js';
import type { EventBus } from '../ingest/event-bus.js';
import { EngineStore, type Snapshot } from './engine.store.js';

const latestClose = (s: EngineState): number =>
  Object.entries(s.lastCandleOpenTime).reduce(
    (m, [tf, open]) => Math.max(m, (open as number) + TIMEFRAME_MS[tf as Timeframe]),
    0,
  );

const HOUR_MS = 3_600_000;

export interface EngineLogger {
  warn(message: string): void;
  info(message: string): void;
}

export interface EngineRunnerOptions {
  /** Candles per timeframe read at once while catching up from a cursor. */
  batch?: number;
  /** Most recent candles per timeframe replayed when there is no snapshot (cold start). */
  coldStartBars?: number;
  /** Safety bound on catch-up passes per drain. */
  maxPasses?: number;
  /** Wall clock in ms. Feed health only applies to candles at the live edge, never to history being replayed. */
  now?: () => number;
}

interface Advance {
  state: EngineState;
  events: EngineEvent[];
  snapshot: Snapshot | null;
  candles: number;
  /** Timeframes that started from nothing in this run, with the close time of their first replayed candle. */
  cold: Partial<Record<Timeframe, number>>;
}

/**
 * Feeds closed candles to the pure engine in canonical close order and persists what it emits (A04 section 12).
 *
 * - Triggered by `candle.closed`, but always works from the database: it reads every analysis-timeframe candle
 *   after its per-timeframe cursor, so a missed or reordered notification cannot lose or reorder data.
 * - Events and the hourly snapshot are written in one transaction; in-memory state advances only after the
 *   commit, so a failure is retried from the same point and event ids make the retry idempotent.
 * - One chain of work per instrument; different instruments run independently.
 * - `candle.backfilled` rebuilds from the last snapshot at or before the repaired range and retracts events
 *   that no longer exist (revision bumps, nothing is deleted).
 */
export class EngineRunner {
  private store!: EngineStore;
  private cfg!: StrategyConfig;
  private strategyId = '';
  private readonly states = new Map<string, EngineState>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private readonly batch: number;
  private readonly coldStart: number;
  private readonly maxPasses: number;
  private readonly now: () => number;
  private readonly tickSizes = new Map<string, number>();
  /** Feed health per instrument, from `feed.status` events. */
  private readonly feedState = new Map<string, string>();
  /** Total failed jobs since start (diagnostics). */
  failures = 0;
  /** Instruments whose most recent job failed; empty means healthy. Cleared by the next success. */
  readonly failing = new Set<string>();
  /** Rebuilds requested but not yet completed: a failed rebuild is retried, never forgotten. */
  private readonly pendingRebuild = new Map<string, { canonical: string; fromMs: number }>();

  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus,
    private readonly candles: CandleStore,
    private readonly log: EngineLogger,
    options: EngineRunnerOptions = {},
  ) {
    this.batch = options.batch ?? 3000;
    this.coldStart = options.coldStartBars ?? 3000;
    this.maxPasses = options.maxPasses ?? 50;
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns false (and stays idle) when there is no ACTIVE strategy version. */
  async start(): Promise<boolean> {
    this.store = new EngineStore(this.sql);
    const strategy = await this.store.activeStrategy();
    if (!strategy) {
      this.log.warn('engine: no ACTIVE smc-core strategy version; the engine stays idle');
      return false;
    }
    this.cfg = strategy.config;
    this.strategyId = strategy.id;
    this.unsubscribe.push(
      this.bus.subscribe('candle.closed', (e) => {
        if (!this.cfg.timeframes.analysis.includes(e.tf)) return;
        this.enqueueDrain(e.instrumentId, e.canonical);
      }),
      this.bus.subscribe('feed.status', (e) => {
        this.feedState.set(e.instrumentId, e.state);
      }),
      this.bus.subscribe('candle.backfilled', (e) => {
        const earlier = this.pendingRebuild.get(e.instrumentId);
        this.pendingRebuild.set(e.instrumentId, {
          canonical: e.canonical,
          fromMs: Math.min(e.fromMs, earlier?.fromMs ?? Number.POSITIVE_INFINITY),
        });
        this.schedule(e.instrumentId, () => this.runPendingRebuild(e.instrumentId));
      }),
    );
    this.log.info(`engine: running strategy version ${this.strategyId}`);
    return true;
  }

  async stop(): Promise<void> {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** State held in memory for an instrument (tests and facts endpoints). */
  stateOf(instrumentId: string): EngineState | undefined {
    return this.states.get(instrumentId);
  }

  get config(): StrategyConfig {
    return this.cfg;
  }

  private enqueueDrain(instrumentId: string, canonical: string): void {
    // Five timeframes close together; one queued drain already covers them all.
    if (this.queued.has(instrumentId)) return;
    this.queued.add(instrumentId);
    this.schedule(instrumentId, async () => {
      this.queued.delete(instrumentId);
      await this.drain(instrumentId, canonical);
    });
  }

  private schedule(instrumentId: string, job: () => Promise<void>): void {
    const previous = this.chains.get(instrumentId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await job();
        this.failing.delete(instrumentId);
      })
      .catch((e: unknown) => {
        this.failures++;
        this.failing.add(instrumentId);
        this.log.warn(
          `engine: work for ${instrumentId} failed: ${(e as Error)?.constructor?.name}`,
        );
      })
      .finally(() => {
        if (this.chains.get(instrumentId) === next) this.chains.delete(instrumentId);
      });
    this.chains.set(instrumentId, next);
  }

  private async hydrate(instrumentId: string, canonical: string): Promise<EngineState> {
    const cached = this.states.get(instrumentId);
    if (cached) return cached;
    const snap = await this.store.latestSnapshot(instrumentId, this.strategyId);
    const state = this.validState(snap?.state, canonical) ?? createEngine(canonical);
    this.states.set(instrumentId, state);
    return state;
  }

  private validState(state: EngineState | undefined, canonical: string): EngineState | null {
    return state && state.v === STATE_VERSION && state.instrumentId === canonical ? state : null;
  }

  /** Reads what is new for each analysis timeframe and runs the engine over it in canonical order. */
  private async tickSize(instrumentId: string): Promise<number> {
    const cached = this.tickSizes.get(instrumentId);
    if (cached !== undefined) return cached;
    const [row] = await this.sql<
      { tick_size: string }[]
    >`select tick_size from instruments where id = ${instrumentId}`;
    const tick = row ? Number(row.tick_size) : 0;
    this.tickSizes.set(instrumentId, tick);
    return tick;
  }

  /** Step options for a candle: feed health only counts at the live edge, never for history. */
  private stepOptions(
    instrumentId: string,
    tickSize: number,
    closeTime: number,
    tfMs: number,
  ): StepOptions {
    const live = this.now() - closeTime <= 3 * tfMs;
    const state = this.feedState.get(instrumentId);
    const dataQuality =
      live && (state === 'DEGRADED' || state === 'STALE')
        ? (state as 'DEGRADED' | 'STALE')
        : undefined;
    return { tickSize, ...(dataQuality ? { dataQuality } : {}) };
  }

  private async advance(instrumentId: string, from: EngineState): Promise<Advance> {
    const tickSize = await this.tickSize(instrumentId);
    let state = from;
    const events: EngineEvent[] = [];
    let snapshot: Snapshot | null = null;
    let total = 0;
    const cold: Partial<Record<Timeframe, number>> = {};
    for (let pass = 0; pass < this.maxPasses; pass++) {
      const fresh: Candle[] = [];
      let safeUntil = Number.POSITIVE_INFINITY;
      for (const tf of this.cfg.timeframes.analysis) {
        const cursor = state.lastCandleOpenTime[tf];
        const limit = cursor === undefined ? this.coldStart : this.batch;
        const rows = await this.candles.closedAfter(instrumentId, tf, cursor, limit);
        for (const r of rows) {
          fresh.push({
            instrumentId: state.instrumentId,
            tf,
            openTime: r.openTime,
            o: r.o,
            h: r.h,
            l: r.l,
            c: r.c,
            v: r.v,
            closed: true,
            providerId: r.providerId,
            ...(r.flags ? { flags: r.flags } : {}),
          });
        }
        const last = rows[rows.length - 1];
        // A full batch means more rows exist beyond it: do not run past what this timeframe has shown.
        if (cursor !== undefined && rows.length === limit && last) {
          safeUntil = Math.min(safeUntil, last.openTime + TIMEFRAME_MS[tf]);
        }
      }
      const ordered = orderByClose(fresh).filter(
        (c) => c.openTime + TIMEFRAME_MS[c.tf] <= safeUntil,
      );
      if (ordered.length === 0) break;
      for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i] as Candle;
        if (from.lastCandleOpenTime[c.tf] === undefined && cold[c.tf] === undefined) {
          cold[c.tf] = c.openTime + TIMEFRAME_MS[c.tf];
        }
        const r = step(
          state,
          c,
          this.cfg,
          this.stepOptions(
            instrumentId,
            tickSize,
            c.openTime + TIMEFRAME_MS[c.tf],
            TIMEFRAME_MS[c.tf],
          ),
        );
        state = r.state;
        events.push(...r.events);
        total++;
        const close = c.openTime + TIMEFRAME_MS[c.tf];
        const next = ordered[i + 1];
        const closeAfter = next ? next.openTime + TIMEFRAME_MS[next.tf] : Number.POSITIVE_INFINITY;
        // Snapshot only on a whole-hour close, after every candle of that close has been applied.
        if (close % HOUR_MS === 0 && closeAfter !== close) snapshot = { asOf: close, state };
      }
    }
    return { state, events, snapshot, candles: total, cold };
  }

  private async drain(instrumentId: string, canonical: string): Promise<void> {
    if (this.pendingRebuild.has(instrumentId)) {
      await this.runPendingRebuild(instrumentId); // also catches up, so nothing else is needed
      return;
    }
    const from = await this.hydrate(instrumentId, canonical);
    const r = await this.advance(instrumentId, from);
    if (r.candles === 0) return;
    const { written } = await this.store.persist(
      instrumentId,
      this.strategyId,
      r.events,
      r.snapshot,
    );
    this.states.set(instrumentId, r.state);
    const asOf = latestClose(r.state);
    this.bus.publish('engine.updated', {
      instrumentId,
      canonical,
      asOf,
      events: written,
      rebuilt: false,
    });
  }

  private async runPendingRebuild(instrumentId: string): Promise<void> {
    const request = this.pendingRebuild.get(instrumentId);
    if (!request) return;
    await this.rebuild(instrumentId, request.canonical, request.fromMs);
    // Only forget the request if nothing asked for an earlier point while it ran.
    const now = this.pendingRebuild.get(instrumentId);
    if (now && now.fromMs >= request.fromMs) this.pendingRebuild.delete(instrumentId);
  }

  private async rebuild(instrumentId: string, canonical: string, fromMs: number): Promise<void> {
    const snap = await this.store.latestSnapshot(instrumentId, this.strategyId, fromMs);
    const base = this.validState(snap?.state, canonical) ?? createEngine(canonical);
    const afterMs = snap?.asOf ?? 0;
    const r = await this.advance(instrumentId, base);
    const { written, retracted } = await this.store.persist(
      instrumentId,
      this.strategyId,
      r.events,
      r.snapshot,
      { afterMs, cold: r.cold, staleAfterMs: snap?.asOf ?? fromMs },
    );
    this.states.set(instrumentId, r.state);
    this.log.info(
      `engine: rebuilt ${canonical} from ${new Date(afterMs).toISOString()} (${written} written, ${retracted} retracted)`,
    );
    this.bus.publish('engine.updated', {
      instrumentId,
      canonical,
      asOf: latestClose(r.state),
      events: written,
      rebuilt: true,
    });
  }
}
