import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import {
  BinanceProvider,
  BybitProvider,
  type FeedStatus,
  type MarketDataProvider,
  type Subscription,
  type SubscriptionSpec,
} from '@smc/market-data';
import { BackfillService } from './backfill.service.js';
import { CandleStore } from './candle-store.js';
import type { EventBus } from './event-bus.js';
import { FeedMonitor, type MonitoredFeed } from './feed-monitor.js';
import { type Clock, type IngestLogger, IngestService } from './ingest.service.js';
import { InstrumentRegistry, type InstrumentRow } from './instrument-registry.js';
import { InMemoryJobQueue, type JobQueue, PgBossJobQueue } from './job-queue.js';

const SIX_HOURS = 6 * 3_600_000;

export interface RuntimeClock extends Clock {
  setInterval(fn: () => void, ms: number): () => void;
}

export const systemClock: RuntimeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};

/** Everything the live feed needs, assembled once. Start order follows B02 section 4: warm state, then streams. */
export class IngestRuntime {
  readonly providers = new Map<string, MarketDataProvider>();
  readonly providerStatus = new Map<
    string,
    { status: FeedStatus; detail: string | undefined; at: number }
  >();
  registry!: InstrumentRegistry;
  store!: CandleStore;
  ingest!: IngestService;
  backfill!: BackfillService;
  monitor!: FeedMonitor;
  private queue!: JobQueue;
  private subscriptions: Subscription[] = [];
  private cancelPartitions: (() => void) | null = null;
  private started = false;

  constructor(
    private readonly env: Env,
    private readonly sql: Sql,
    private readonly bus: EventBus,
    private readonly log: IngestLogger,
    private readonly clock: RuntimeClock = systemClock,
  ) {}

  get connected(): boolean {
    return this.started && [...this.providers.values()].every((p) => p.health().connected);
  }

  async start(): Promise<void> {
    this.store = new CandleStore(this.sql);
    this.registry = await InstrumentRegistry.load(this.sql);

    const sessionUrl = this.env.DATABASE_URL_SESSION ?? this.env.DATABASE_URL;
    this.queue = sessionUrl
      ? new PgBossJobQueue(sessionUrl, (e) =>
          this.log.warn(`job queue error: ${(e as Error)?.constructor?.name}`),
        )
      : new InMemoryJobQueue();

    this.providers.set(
      'binance',
      new BinanceProvider({
        wsUrl: { SPOT: this.env.BINANCE_WS_URL, PERP: this.env.BINANCE_PERP_WS_URL },
        restUrl: { SPOT: this.env.BINANCE_REST_URL, PERP: this.env.BINANCE_PERP_REST_URL },
      }),
    );
    this.providers.set(
      'bybit',
      new BybitProvider({ wsUrl: this.env.BYBIT_WS_URL, restUrl: this.env.BYBIT_REST_URL }),
    );

    this.ingest = new IngestService(
      this.store,
      this.registry,
      this.bus,
      this.queue,
      this.clock,
      this.log,
    );
    this.backfill = new BackfillService(
      this.store,
      this.registry,
      this.providers,
      this.ingest,
      this.bus,
      this.queue,
      this.clock,
      this.log,
    );

    const universe = this.registry.all().filter((i) => this.providers.has(i.providerId));
    const feeds: MonitoredFeed[] = universe.map((instrument) => ({
      instrument,
      health: () => (this.providers.get(instrument.providerId) as MarketDataProvider).health(),
    }));
    this.monitor = new FeedMonitor(feeds, this.ingest, this.store, this.bus, this.clock, this.log);

    await this.store.maintainPartitions();
    this.cancelPartitions = this.clock.setInterval(() => {
      void this.store
        .maintainPartitions()
        .catch(() => this.log.warn('partition maintenance failed'));
    }, SIX_HOURS);

    await this.queue.start();
    await this.backfill.register();

    for (const [providerId, provider] of this.providers) {
      const specs: SubscriptionSpec[] = universe
        .filter((i) => i.providerId === providerId)
        .map((i) => ({ venueSymbol: i.venueSymbol, marketType: i.marketType, tf: '1m' }));
      if (specs.length === 0) continue;
      this.subscriptions.push(
        await provider.subscribe(specs, {
          onRaw: (raw) => {
            this.ingest
              .handleRaw(provider.id, raw, 'live')
              .catch((e: unknown) =>
                this.log.warn(
                  `ingest failed for ${raw.venueSymbol}: ${(e as Error)?.constructor?.name}`,
                ),
              );
          },
          onStatus: (status, detail) => this.onProviderStatus(providerId, status, detail),
        }),
      );
    }

    this.bus.subscribe('feed.status', (e) =>
      this.log.info(
        `feed ${e.canonical}: ${e.state}${e.reasons.length ? ` (${e.reasons.join(', ')})` : ''}`,
      ),
    );
    this.bus.subscribe('dq.incident', (e) =>
      this.log.warn(
        `data-quality incident ${e.opened ? 'opened' : 'closed'}: ${e.rule} on ${e.instrumentId}`,
      ),
    );
    this.monitor.start();
    this.started = true;
    // Warm-up runs in the background; live candles are already flowing and gap detection covers the join.
    void this.seedAll(universe);
  }

  private async seedAll(universe: readonly InstrumentRow[]): Promise<void> {
    for (const instrument of universe) {
      try {
        await this.backfill.seed(instrument);
      } catch (e) {
        this.log.warn(
          `seed failed for ${instrument.canonical}: ${(e as Error)?.constructor?.name}`,
        );
      }
    }
    this.log.info('warm-up seeding finished');
  }

  private onProviderStatus(
    providerId: string,
    status: FeedStatus,
    detail: string | undefined,
  ): void {
    this.providerStatus.set(providerId, { status, detail, at: this.clock.now() });
    if (status === 'GEO_BLOCKED') {
      // The IP range is blocked: retrying will not help, someone has to move the machine (A03 section 6.1).
      this.log.warn(`${providerId}: GEO_BLOCKED - the venue refuses this IP range`);
    } else if (status === 'DISCONNECTED' || status === 'RATE_LIMITED') {
      this.log.warn(`${providerId}: ${status}${detail ? ` (${detail})` : ''}`);
    } else {
      this.log.info(`${providerId}: ${status}`);
    }
  }

  async stop(): Promise<void> {
    this.monitor?.stop();
    this.cancelPartitions?.();
    for (const s of this.subscriptions) s.close();
    this.subscriptions = [];
    this.ingest?.stop();
    await this.ingest?.idle();
    await this.queue?.stop();
    this.started = false;
  }
}
