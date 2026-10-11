import { TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import type { Sql } from '@smc/db';
import {
  aggregateBucket,
  bucketStart,
  CORE_VALIDATION,
  closesBucket,
  DERIVED_TIMEFRAMES,
  FLAG,
  normalize,
  type ProviderId,
  type QuarantineReason,
  type RawCandle,
  type StoredCandle,
  type ValidationConfig,
  validate,
} from '@smc/market-data';
import type { CandleStore } from './candle-store.js';
import type { BusEvents, EventBus } from './event-bus.js';
import type { InstrumentRegistry, InstrumentRow } from './instrument-registry.js';
import type { JobQueue } from './job-queue.js';

export type HandleResult =
  | { kind: 'stored' }
  | { kind: 'duplicate' }
  | { kind: 'quarantined'; reason: QuarantineReason }
  | { kind: 'unmapped' }
  | { kind: 'forming' };

export type Source = 'live' | 'backfill';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

export interface IngestLogger {
  warn(message: string): void;
  info(message: string): void;
}

export interface IngestOptions {
  /** A higher-timeframe candle with a missing minute waits this long for a backfill before it is stored INCOMPLETE. */
  readonly incompleteTimeoutMs?: number;
  /** Gaps longer than this are not auto-backfilled in one job (operator decision). */
  readonly maxAutoBackfillMs?: number;
  readonly validation?: ValidationConfig;
  /** Consecutive agreeing cross-checks before a divergence incident closes itself. */
  readonly agreeToClose?: number;
}

const MINUTE = 60_000;
const RECENT_CAP = 240;
const MAX_PENDING_PER_INSTRUMENT = 5000;

interface InstrumentState {
  lastOpen: number | null;
  loaded: boolean;
  readonly recent: Map<number, StoredCandle>;
  flatStreak: number;
  agreeStreak: number;
  incidentOpen: boolean;
  pending: number;
  readonly timers: Map<string, () => void>;
}

type PublishedEvent = {
  [K in keyof BusEvents]: { name: K; payload: BusEvents[K] };
}[keyof BusEvents];

/**
 * Venue candle in, validated candle out (A03 section 5). One instance serialises work per instrument, writes the
 * 1m candle and every higher-timeframe candle it completes in ONE transaction, and publishes events only after the
 * commit (write-then-publish), so a consumer that reads the database after an event always sees the candle.
 * Everything is idempotent on the candle primary key: replaying the same input leaves the same rows.
 */
export class IngestService {
  private readonly states = new Map<string, InstrumentState>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly config: Required<Omit<IngestOptions, 'validation'>> & {
    validation: ValidationConfig;
  };

  /** Counters for operators; exposed through the admin feeds endpoint. */
  readonly counters = { stored: 0, duplicates: 0, quarantined: 0, unmapped: 0 };

  constructor(
    private readonly store: CandleStore,
    private readonly registry: InstrumentRegistry,
    private readonly bus: EventBus,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly log: IngestLogger,
    options: IngestOptions = {},
  ) {
    this.config = {
      incompleteTimeoutMs: options.incompleteTimeoutMs ?? 90_000,
      maxAutoBackfillMs: options.maxAutoBackfillMs ?? 3 * 24 * 3_600_000,
      validation: options.validation ?? CORE_VALIDATION,
      agreeToClose: options.agreeToClose ?? 5,
    };
  }

  /** Entry point for adapters and backfill. Work for one instrument runs strictly in arrival order. */
  handleRaw(providerId: ProviderId, raw: RawCandle, source: Source): Promise<HandleResult> {
    const instrument = this.registry.forVenueSymbol(providerId, raw.marketType, raw.venueSymbol);
    if (!instrument) {
      this.counters.unmapped += 1;
      return this.store
        .quarantine(null, providerId, 'UNMAPPED_SYMBOL', {
          venueSymbol: raw.venueSymbol,
          marketType: raw.marketType,
        })
        .then(() => ({ kind: 'unmapped' }) as const);
    }
    const state = this.stateOf(instrument.id);
    if (state.pending >= MAX_PENDING_PER_INSTRUMENT) {
      this.log.warn(
        `ingest backlog for ${instrument.canonical} exceeded ${MAX_PENDING_PER_INSTRUMENT}; dropping a candle`,
      );
      return Promise.resolve({ kind: 'forming' } as const);
    }
    state.pending += 1;
    const previous = this.chains.get(instrument.id) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.process(instrument, providerId, raw, source))
      .finally(() => {
        state.pending -= 1;
      });
    this.chains.set(instrument.id, run);
    return run;
  }

  /** Waits for everything queued so far (shutdown and tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()].map((p) => p.catch(() => {})));
  }

  stateSnapshot(instrumentId: string): {
    lastOpen: number | null;
    flatStreak: number;
    incidentOpen: boolean;
  } {
    const s = this.states.get(instrumentId);
    return {
      lastOpen: s?.lastOpen ?? null,
      flatStreak: s?.flatStreak ?? 0,
      incidentOpen: s?.incidentOpen ?? false,
    };
  }

  stop(): void {
    for (const state of this.states.values()) for (const cancel of state.timers.values()) cancel();
  }

  private stateOf(id: string): InstrumentState {
    let s = this.states.get(id);
    if (!s) {
      s = {
        lastOpen: null,
        loaded: false,
        recent: new Map(),
        flatStreak: 0,
        agreeStreak: 0,
        incidentOpen: false,
        pending: 0,
        timers: new Map(),
      };
      this.states.set(id, s);
    }
    return s;
  }

  private async load(instrument: InstrumentRow, state: InstrumentState): Promise<void> {
    if (state.loaded) return;
    state.lastOpen = await this.store.latestOpenTime(instrument.id, '1m');
    state.incidentOpen = await this.store.hasOpenIncident(instrument.id);
    state.loaded = true;
  }

  private async process(
    instrument: InstrumentRow,
    providerId: ProviderId,
    raw: RawCandle,
    source: Source,
  ): Promise<HandleResult> {
    if (!raw.closed) return { kind: 'forming' };
    const state = this.stateOf(instrument.id);
    await this.load(instrument, state);

    const normalized = normalize(raw, instrument.id, providerId);
    if (!normalized.ok) return this.reject(instrument, providerId, normalized.reason, raw);
    const candle = normalized.candle;

    const prev =
      state.recent.get(candle.openTime - MINUTE) ??
      (await this.store.get(instrument.id, '1m', candle.openTime - MINUTE));
    const existing =
      state.recent.get(candle.openTime) ??
      (await this.store.get(instrument.id, '1m', candle.openTime));
    const peer = this.registry.peerOf(instrument.id);
    const peerCandle = peer ? this.states.get(peer.id)?.recent.get(candle.openTime) : undefined;

    const result = validate(
      candle,
      {
        nowMs: this.clock.now(),
        canonical: instrument.canonical,
        existing,
        previous: prev,
        peer:
          peer && peerCandle ? { instrumentId: peer.canonical, close: peerCandle.c } : undefined,
      },
      this.config.validation,
    );
    if (!result.ok) {
      if (result.reason === 'CONFLICTING_DUPLICATE') {
        await this.openIncident(instrument, 'V5', { openTime: candle.openTime });
      }
      return this.reject(instrument, providerId, result.reason, raw);
    }
    if (result.duplicate) {
      this.counters.duplicates += 1;
      return { kind: 'duplicate' };
    }

    const flags = result.flags | (source === 'backfill' ? FLAG.BACKFILLED : 0);
    const stored: StoredCandle = { ...candle, closed: true, flags, status: 'CLOSED' };
    const lastBefore = state.lastOpen;
    const events: PublishedEvent[] = [];

    const inserted = await this.store.begin(async (tx) => {
      if (!(await this.store.insertCandle(stored, tx))) return false;
      const reachedMs = Math.max(lastBefore ?? 0, stored.openTime) + MINUTE;
      for (const tf of DERIVED_TIMEFRAMES) {
        await this.evaluateBucket(
          instrument,
          state,
          tf,
          bucketStart(stored.openTime, tf),
          reachedMs,
          source,
          stored,
          tx,
          events,
        );
      }
      return true;
    });
    if (!inserted) {
      this.counters.duplicates += 1;
      return { kind: 'duplicate' };
    }

    // Committed: update memory, then tell the world.
    this.counters.stored += 1;
    state.recent.set(stored.openTime, stored);
    if (state.recent.size > RECENT_CAP) {
      const oldest = Math.min(...state.recent.keys());
      state.recent.delete(oldest);
    }
    if (state.lastOpen === null || stored.openTime > state.lastOpen) {
      state.lastOpen = stored.openTime;
      state.flatStreak = flags & FLAG.FLAT ? state.flatStreak + 1 : 0;
    }
    // A backfill announces itself once for the whole range (BackfillService), not candle by candle.
    if (source === 'live') {
      this.bus.publish('candle.closed', {
        instrumentId: instrument.id,
        canonical: instrument.canonical,
        tf: '1m',
        openTime: stored.openTime,
        status: 'CLOSED',
        source,
      });
      for (const e of events) this.bus.publish(e.name, e.payload as never);
    }

    if (source === 'live' && lastBefore !== null && stored.openTime > lastBefore + MINUTE) {
      await this.onGap(instrument, lastBefore + MINUTE, stored.openTime);
    }
    await this.crosscheck(instrument, state, stored, result.crosscheck);
    return { kind: 'stored' };
  }

  private async reject(
    instrument: InstrumentRow,
    providerId: ProviderId,
    reason: QuarantineReason,
    raw: RawCandle,
  ): Promise<HandleResult> {
    this.counters.quarantined += 1;
    await this.store.quarantine(instrument.id, providerId, reason, {
      venueSymbol: raw.venueSymbol,
      marketType: raw.marketType,
      openTimeMs: raw.openTimeMs,
      o: raw.o,
      h: raw.h,
      l: raw.l,
      c: raw.c,
      v: raw.v ?? null,
    });
    return { kind: 'quarantined', reason };
  }

  /**
   * Builds the `tf` candle for a bucket once the stream has reached its end. Complete -> CLOSED; a missing minute on
   * the live closing minute waits for a backfill and is stored INCOMPLETE after the timeout; a later backfill that
   * completes it upgrades the row and announces `candle.backfilled` so consumers recompute.
   */
  private async evaluateBucket(
    instrument: InstrumentRow,
    state: InstrumentState,
    tf: Timeframe,
    bucketOpen: number,
    reachedMs: number,
    source: Source,
    justInserted: StoredCandle,
    tx: Sql,
    events: PublishedEvent[],
  ): Promise<void> {
    const bucketEnd = bucketOpen + TIMEFRAME_MS[tf];
    if (reachedMs < bucketEnd) return;
    const children = await this.store.range(instrument.id, '1m', bucketOpen, bucketEnd, tx);
    const agg = aggregateBucket(children, bucketOpen, tf);
    if (!agg) return;
    const timerKey = `${tf}|${bucketOpen}`;

    if (agg.missing.length === 0) {
      state.timers.get(timerKey)?.();
      state.timers.delete(timerKey);
      const outcome = await this.store.upsertHtf(agg.candle, tx);
      if (outcome === 'inserted') {
        events.push({
          name: 'candle.closed',
          payload: {
            instrumentId: instrument.id,
            canonical: instrument.canonical,
            tf,
            openTime: bucketOpen,
            status: 'CLOSED',
            source,
          },
        });
      } else if (outcome === 'upgraded') {
        events.push({
          name: 'candle.backfilled',
          payload: {
            instrumentId: instrument.id,
            canonical: instrument.canonical,
            fromMs: bucketOpen,
            toMs: bucketEnd,
          },
        });
      }
      return;
    }
    // Incomplete: only the live minute that closes the bucket starts the clock; a backfill is already the remedy.
    if (closesBucket(justInserted.openTime, tf) && !state.timers.has(timerKey)) {
      const cancel = this.clock.setTimeout(() => {
        state.timers.delete(timerKey);
        void this.storeIncomplete(instrument, tf, bucketOpen, source).catch((e: unknown) =>
          this.log.warn(
            `storing INCOMPLETE ${tf} candle failed: ${(e as Error)?.constructor?.name}`,
          ),
        );
      }, this.config.incompleteTimeoutMs);
      state.timers.set(timerKey, cancel);
    }
  }

  private async storeIncomplete(
    instrument: InstrumentRow,
    tf: Timeframe,
    bucketOpen: number,
    source: Source,
  ): Promise<void> {
    // Serialise with the instrument's other work.
    const previous = this.chains.get(instrument.id) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        const bucketEnd = bucketOpen + TIMEFRAME_MS[tf];
        const children = await this.store.range(instrument.id, '1m', bucketOpen, bucketEnd);
        const agg = aggregateBucket(children, bucketOpen, tf);
        if (!agg) return;
        const outcome = await this.store.begin((tx) => this.store.upsertHtf(agg.candle, tx));
        if (outcome === 'inserted') {
          this.bus.publish('candle.closed', {
            instrumentId: instrument.id,
            canonical: instrument.canonical,
            tf,
            openTime: bucketOpen,
            status: agg.candle.status,
            source,
          });
        }
      });
    this.chains.set(instrument.id, run);
    await run;
  }

  private async onGap(
    instrument: InstrumentRow,
    fromMs: number,
    nextOpenMs: number,
  ): Promise<void> {
    const toMs = nextOpenMs - MINUTE;
    await this.store.recordGap(instrument.id, '1m', fromMs, toMs);
    if (nextOpenMs - fromMs > this.config.maxAutoBackfillMs) {
      this.log.warn(
        `gap for ${instrument.canonical} is longer than the automatic backfill limit; needs an operator`,
      );
      return;
    }
    await this.queue.enqueue(
      'md.backfill',
      { instrumentId: instrument.id, fromMs, toMs: nextOpenMs },
      { singletonKey: `${instrument.id}:${fromMs}` },
    );
  }

  private async openIncident(
    instrument: InstrumentRow,
    rule: string,
    details: unknown,
  ): Promise<void> {
    const state = this.stateOf(instrument.id);
    state.incidentOpen = true;
    if (await this.store.openIncident(instrument.id, instrument.venue, rule, details)) {
      this.bus.publish('dq.incident', { instrumentId: instrument.id, rule, opened: true });
    }
  }

  /** V7 in both directions: the flag is set whichever venue's candle arrives second (A03 section 5.4). */
  private async crosscheck(
    instrument: InstrumentRow,
    state: InstrumentState,
    stored: StoredCandle,
    verdict: 'NO_PEER' | 'AGREE' | 'DIVERGE',
  ): Promise<void> {
    if (verdict === 'DIVERGE') {
      state.agreeStreak = 0;
      await this.openIncident(instrument, 'V7', { openTime: stored.openTime, close: stored.c });
    } else if (verdict === 'AGREE') {
      await this.noteAgreement(instrument, state);
    }
    // This instrument may itself be the peer of others whose candle arrived first.
    for (const primary of this.registry.primariesCheckedBy(instrument.id)) {
      const primaryState = this.states.get(primary.id);
      const primaryCandle = primaryState?.recent.get(stored.openTime);
      if (!primaryState || !primaryCandle) continue;
      const diffPct = (Math.abs(primaryCandle.c - stored.c) / stored.c) * 100;
      if (diffPct > this.config.validation.crosscheckTolPct) {
        if (!(primaryCandle.flags & FLAG.CROSSCHECK_DIVERGENCE)) {
          await this.store.orFlags(primary.id, '1m', stored.openTime, FLAG.CROSSCHECK_DIVERGENCE);
          primaryState.recent.set(stored.openTime, {
            ...primaryCandle,
            flags: primaryCandle.flags | FLAG.CROSSCHECK_DIVERGENCE,
          });
        }
        primaryState.agreeStreak = 0;
        await this.openIncident(primary, 'V7', {
          openTime: stored.openTime,
          peer: instrument.canonical,
          diffPct,
        });
      } else if (!(primaryCandle.flags & FLAG.CROSSCHECK_DIVERGENCE)) {
        await this.noteAgreement(primary, primaryState);
      }
    }
  }

  private async noteAgreement(instrument: InstrumentRow, state: InstrumentState): Promise<void> {
    if (!state.incidentOpen) return;
    state.agreeStreak += 1;
    if (state.agreeStreak >= this.config.agreeToClose) {
      state.agreeStreak = 0;
      if (await this.store.closeIncident(instrument.id, 'V7')) {
        state.incidentOpen = await this.store.hasOpenIncident(instrument.id);
        this.bus.publish('dq.incident', { instrumentId: instrument.id, rule: 'V7', opened: false });
      }
    }
  }
}
