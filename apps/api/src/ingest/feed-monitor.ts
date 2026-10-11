import {
  type FeedState,
  type FeedStatusResult,
  feedStatus,
  type ProviderHealth,
} from '@smc/market-data';
import type { CandleStore } from './candle-store.js';
import type { EventBus } from './event-bus.js';
import type { IngestLogger, IngestService } from './ingest.service.js';
import type { InstrumentRow } from './instrument-registry.js';

export interface MonitoredFeed {
  readonly instrument: InstrumentRow;
  health(): ProviderHealth;
}

export interface InstrumentFeedStatus extends FeedStatusResult {
  readonly instrumentId: string;
  readonly canonical: string;
  readonly since: number;
  readonly lastClosedOpenMs: number | null;
}

/**
 * Evaluates every feed on a timer and tells the rest of the system when its state changes (A03 section 6.1).
 * While a feed is STALE or DEGRADED consumers must not publish new setups; the state is also what the status
 * endpoints return. STALE additionally opens a `FEED_STALE` incident so the history is auditable.
 */
export class FeedMonitor {
  private readonly current = new Map<string, InstrumentFeedStatus>();
  private cancel: (() => void) | null = null;

  constructor(
    private readonly feeds: readonly MonitoredFeed[],
    private readonly ingest: IngestService,
    private readonly store: CandleStore,
    private readonly bus: EventBus,
    private readonly clock: { now(): number; setInterval(fn: () => void, ms: number): () => void },
    private readonly log: IngestLogger,
  ) {}

  start(everyMs = 5000): void {
    this.cancel = this.clock.setInterval(() => {
      void this.tick().catch((e: unknown) =>
        this.log.warn(`feed monitor tick failed: ${(e as Error)?.constructor?.name}`),
      );
    }, everyMs);
  }

  stop(): void {
    this.cancel?.();
  }

  /** Evaluates all feeds once; exported so tests (and an admin "check now") can drive it. */
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const feed of this.feeds) {
      const snap = this.ingest.stateSnapshot(feed.instrument.id);
      const health = feed.health();
      const result = feedStatus({
        nowMs: now,
        lastMessageAtMs: health.lastMessageAtMs,
        lastClosedOpenMs: snap.lastOpen,
        flatStreak: snap.flatStreak,
        openIncident: snap.incidentOpen,
        disconnected: !health.connected,
      });
      const before = this.current.get(feed.instrument.id);
      if (before?.state === result.state && before.reasons.join() === result.reasons.join())
        continue;

      this.current.set(feed.instrument.id, {
        ...result,
        instrumentId: feed.instrument.id,
        canonical: feed.instrument.canonical,
        since: now,
        lastClosedOpenMs: snap.lastOpen,
      });
      this.bus.publish('feed.status', {
        instrumentId: feed.instrument.id,
        canonical: feed.instrument.canonical,
        state: result.state,
        reasons: result.reasons,
      });
      await this.recordStaleness(feed.instrument, before?.state, result.state, result.reasons);
    }
  }

  private async recordStaleness(
    instrument: InstrumentRow,
    before: FeedState | undefined,
    after: FeedState,
    reasons: readonly string[],
  ): Promise<void> {
    // Waiting for the first candle after a start is warm-up, not an outage worth an incident.
    const real = reasons.some((r) => r === 'CANDLE_OVERDUE' || r === 'FLAT_CANDLES');
    if (after === 'STALE' && before !== 'STALE' && real) {
      if (
        await this.store.openIncident(instrument.id, instrument.venue, 'FEED_STALE', { reasons })
      ) {
        this.bus.publish('dq.incident', {
          instrumentId: instrument.id,
          rule: 'FEED_STALE',
          opened: true,
        });
      }
    } else if (before === 'STALE' && after !== 'STALE') {
      if (await this.store.closeIncident(instrument.id, 'FEED_STALE')) {
        this.bus.publish('dq.incident', {
          instrumentId: instrument.id,
          rule: 'FEED_STALE',
          opened: false,
        });
      }
    }
  }

  statusOf(instrumentId: string): InstrumentFeedStatus | undefined {
    return this.current.get(instrumentId);
  }

  all(): InstrumentFeedStatus[] {
    return [...this.current.values()];
  }
}
