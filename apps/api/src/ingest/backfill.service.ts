import { TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import {
  bucketStart,
  FLAG,
  type MarketDataProvider,
  normalize,
  type StoredCandle,
  validate,
} from '@smc/market-data';
import type { CandleStore } from './candle-store.js';
import type { EventBus } from './event-bus.js';
import type { Clock, IngestLogger, IngestService } from './ingest.service.js';
import type { InstrumentRegistry, InstrumentRow } from './instrument-registry.js';
import type { JobQueue } from './job-queue.js';

const MINUTE = 60_000;

/** Warm-up depth per timeframe (A03 section 7). Higher timeframes come from the venue's own candles. */
export const SEED_BARS: Readonly<Record<'1d' | '4h' | '1h' | '15m' | '5m', number>> = {
  '1d': 400,
  '4h': 500,
  '1h': 800,
  '15m': 1000,
  '5m': 1000,
};
/** 1m history kept hot at the start: warm-up (1,500) plus margin. Longer history is a later, deliberate step. */
export const SEED_1M_MINUTES = 2880;

export interface BackfillJob {
  readonly instrumentId: string;
  /** Inclusive candle open time. */
  readonly fromMs: number;
  /** Exclusive. */
  readonly toMs: number;
}

export interface ReconcileReport {
  readonly instrument: string;
  readonly compared: number;
  readonly missingNative: number;
  readonly differences: {
    tf: Timeframe;
    openTime: string;
    field: string;
    ours: number;
    venue: number;
  }[];
}

/** Relative tolerance for comparing our aggregated OHLC with the venue's own higher-timeframe candle. */
const RECONCILE_TOLERANCE = 1e-5;

export class BackfillIncompleteError extends Error {
  constructor(readonly missing: number) {
    super(`backfill left ${missing} minute(s) missing`);
    this.name = 'BackfillIncompleteError';
  }
}

/**
 * Fills history through the same validate-and-store pipeline as live data (A03 section 6.2) and seeds warm-up
 * history for a new instrument. Idempotent end to end: running a job twice leaves the same rows.
 */
export class BackfillService {
  constructor(
    private readonly store: CandleStore,
    private readonly registry: InstrumentRegistry,
    private readonly providers: ReadonlyMap<string, MarketDataProvider>,
    private readonly ingest: IngestService,
    private readonly bus: EventBus,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    private readonly log: IngestLogger,
  ) {}

  async register(): Promise<void> {
    await this.queue.process<BackfillJob>('md.backfill', (job) => this.run(job), {
      concurrency: 2,
    });
    await this.queue.process<object>('md.reconcile', async () => {
      for (const instrument of this.registry.all()) {
        if (this.providers.has(instrument.providerId)) await this.reconcile(instrument);
      }
    });
    await this.queue.schedule('md.reconcile', '0 3 * * *'); // quiet window, UTC (A03 section 8.2)
  }

  /**
   * Nightly check (A03 section 5.3): fetch the venue's own 1h/4h/1d candles for the last 7 days and compare them with
   * the ones we aggregated. A difference opens a RECONCILE incident for an operator; nothing is overwritten silently.
   */
  async reconcile(instrument: InstrumentRow, days = 7): Promise<ReconcileReport> {
    const provider = this.providerFor(instrument);
    const now = this.clock.now();
    const report: {
      compared: number;
      missingNative: number;
      differences: ReconcileReport['differences'];
    } = { compared: 0, missingNative: 0, differences: [] };

    for (const tf of ['1h', '4h', '1d'] as const) {
      const toMs = bucketStart(now, tf);
      const fromMs = toMs - days * 86_400_000;
      const ours = new Map(
        (await this.store.range(instrument.id, tf, fromMs, toMs)).map((c) => [c.openTime, c]),
      );
      const venue = new Map<number, number[]>();
      for await (const page of provider.fetchCandles({
        venueSymbol: instrument.venueSymbol,
        marketType: instrument.marketType,
        tf,
        fromMs,
        toMs,
      })) {
        for (const r of page) {
          if (r.closed)
            venue.set(r.openTimeMs, [Number(r.o), Number(r.h), Number(r.l), Number(r.c)]);
        }
      }
      for (const [openTime, mine] of ours) {
        if (mine.status !== 'CLOSED') continue;
        const theirs = venue.get(openTime);
        if (!theirs) {
          report.missingNative += 1;
          continue;
        }
        report.compared += 1;
        const fields = [
          ['o', mine.o],
          ['h', mine.h],
          ['l', mine.l],
          ['c', mine.c],
        ] as const;
        fields.forEach(([field, value], i) => {
          const other = theirs[i] as number;
          if (Math.abs(value - other) / other > RECONCILE_TOLERANCE) {
            report.differences.push({
              tf,
              openTime: new Date(openTime).toISOString(),
              field,
              ours: value,
              venue: other,
            });
          }
        });
      }
    }

    if (report.differences.length > 0) {
      this.log.warn(
        `reconcile: ${report.differences.length} difference(s) on ${instrument.canonical}`,
      );
      const opened = await this.store.openIncident(instrument.id, instrument.venue, 'RECONCILE', {
        differences: report.differences.slice(0, 20),
      });
      if (opened) {
        this.bus.publish('dq.incident', {
          instrumentId: instrument.id,
          rule: 'RECONCILE',
          opened: true,
        });
      }
    } else {
      await this.store.closeIncident(instrument.id, 'RECONCILE');
    }
    return { instrument: instrument.canonical, ...report };
  }

  private providerFor(instrument: InstrumentRow): MarketDataProvider {
    const provider = this.providers.get(instrument.providerId);
    if (!provider) throw new Error(`no provider registered for ${instrument.providerId}`);
    return provider;
  }

  /** Re-fetches [fromMs, toMs) of 1m candles for one instrument. Throws when minutes are still missing so the queue retries. */
  async run(job: BackfillJob): Promise<void> {
    return this.ingest.withBackfillActive(job.instrumentId, () => this.runInner(job));
  }

  private async runInner(job: BackfillJob): Promise<void> {
    const instrument = this.registry.get(job.instrumentId);
    if (!instrument) throw new Error(`unknown instrument ${job.instrumentId}`);
    const provider = this.providerFor(instrument);
    const gapTo = job.toMs - MINUTE;
    await this.store.ensurePartitions(job.fromMs, job.toMs);
    await this.store.setGapStatus(instrument.id, job.fromMs, gapTo, 'BACKFILLING');

    let received = 0;
    for await (const page of provider.fetchCandles({
      venueSymbol: instrument.venueSymbol,
      marketType: instrument.marketType,
      tf: '1m',
      fromMs: job.fromMs,
      toMs: job.toMs,
    })) {
      for (const raw of page) {
        if (raw.openTimeMs < job.fromMs || raw.openTimeMs >= job.toMs) continue;
        received += 1;
        await this.ingest.handleRaw(provider.id, raw, 'backfill');
      }
    }
    await this.ingest.idle();

    const have = await this.store.range(instrument.id, '1m', job.fromMs, job.toMs);
    const expected = (job.toMs - job.fromMs) / MINUTE;
    const missing = expected - have.length;
    if (missing > 0) {
      // The venue may genuinely have no data (maintenance); do not retry forever for an old, empty range.
      const old = this.clock.now() - job.toMs > 60 * MINUTE;
      if (old && received === 0) {
        await this.store.setGapStatus(instrument.id, job.fromMs, gapTo, 'UNRESOLVABLE');
        this.log.warn(
          `backfill for ${instrument.canonical} found no venue data; marked UNRESOLVABLE`,
        );
        return;
      }
      throw new BackfillIncompleteError(missing);
    }
    await this.store.setGapStatus(instrument.id, job.fromMs, gapTo, 'RESOLVED');
    this.bus.publish('candle.backfilled', {
      instrumentId: instrument.id,
      canonical: instrument.canonical,
      fromMs: job.fromMs,
      toMs: job.toMs,
    });
  }

  /**
   * Warm-up for a new or long-idle instrument: native venue candles for 5m..1d (one request series per timeframe),
   * and the recent 1m window through the queue. Native bars are stored as BACKFILLED; live aggregation continues
   * from the next bucket, and the nightly reconcile compares the two (A03 section 5.3).
   */
  async seed(instrument: InstrumentRow): Promise<void> {
    const provider = this.providerFor(instrument);
    const now = this.clock.now();

    for (const tf of ['1d', '4h', '1h', '15m', '5m'] as const) {
      const tfMs = TIMEFRAME_MS[tf];
      const toMs = bucketStart(now, tf); // completed bars only
      const fromMs = toMs - SEED_BARS[tf] * tfMs;
      const have = await this.store.range(instrument.id, tf, fromMs, toMs);
      if (have.length >= SEED_BARS[tf] * 0.98) continue;
      await this.seedTimeframe(instrument, provider, tf, fromMs, toMs, now);
    }

    // Judge the window by what is actually stored, not by the newest candle: an interrupted seed or a restart can
    // leave the newest minutes present and the older ones missing. Existing rows are skipped as duplicates.
    const toMs = Math.floor(now / MINUTE) * MINUTE;
    const fromMs = toMs - SEED_1M_MINUTES * MINUTE;
    await this.store.ensurePartitions(fromMs, toMs);
    const stored = (await this.store.range(instrument.id, '1m', fromMs, toMs)).length;
    if (stored < SEED_1M_MINUTES * 0.98) {
      await this.queue.enqueue<BackfillJob>(
        'md.backfill',
        { instrumentId: instrument.id, fromMs, toMs },
        { singletonKey: `${instrument.id}:seed:${fromMs}` },
      );
    }
  }

  private async seedTimeframe(
    instrument: InstrumentRow,
    provider: MarketDataProvider,
    tf: Timeframe,
    fromMs: number,
    toMs: number,
    nowMs: number,
  ): Promise<void> {
    await this.store.ensurePartitions(fromMs, toMs);
    let stored = 0;
    for await (const page of provider.fetchCandles({
      venueSymbol: instrument.venueSymbol,
      marketType: instrument.marketType,
      tf,
      fromMs,
      toMs,
    })) {
      for (const raw of page) {
        if (!raw.closed || raw.openTimeMs >= toMs) continue;
        const n = normalize(raw, instrument.id, provider.id);
        if (!n.ok) continue;
        const v = validate(n.candle, { nowMs, canonical: instrument.canonical });
        if (!v.ok) continue;
        const candle: StoredCandle = {
          ...n.candle,
          closed: true,
          flags: v.flags | FLAG.BACKFILLED,
          status: 'CLOSED',
        };
        if (await this.store.insertCandle(candle)) stored += 1;
      }
    }
    this.log.info(`seeded ${stored} ${tf} candles for ${instrument.canonical}`);
  }
}
