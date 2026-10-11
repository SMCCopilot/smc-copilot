import { TIMEFRAME_MS } from '@smc/contracts';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import {
  type FetchRequest,
  FLAG,
  type MarketDataProvider,
  type ProviderHealth,
  type RawCandle,
} from '@smc/market-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BackfillIncompleteError, BackfillService } from '../src/ingest/backfill.service.js';
import { CandleStore } from '../src/ingest/candle-store.js';
import { type BusEvents, InMemoryEventBus } from '../src/ingest/event-bus.js';
import { FeedMonitor } from '../src/ingest/feed-monitor.js';
import { type Clock, IngestService } from '../src/ingest/ingest.service.js';
import { InstrumentRegistry } from '../src/ingest/instrument-registry.js';
import { InMemoryJobQueue } from '../src/ingest/job-queue.js';

const MIN = 60_000;
const BASE = Date.UTC(2026, 9, 11, 12, 0);

class FakeClock implements Clock {
  nowMs = BASE + 3 * 86_400_000;
  now = () => this.nowMs;
  setTimeout(): () => void {
    return () => {};
  }
  setInterval(): () => void {
    return () => {};
  }
}

/** A venue that holds a fixed set of candles and serves them by timeframe and range. */
class FakeVenue implements MarketDataProvider {
  readonly id = 'binance' as const;
  readonly capabilities = {
    streamsClosedCandles: true,
    nativeTimeframes: [],
    supportsTicks: false,
  };
  readonly requests: FetchRequest[] = [];
  data: RawCandle[] = [];
  healthy: ProviderHealth = { connected: true, lastMessageAtMs: 0, reconnects: 0 };
  constructor(private readonly clock: Clock) {}
  subscribe(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  async *fetchCandles(request: FetchRequest): AsyncIterable<RawCandle[]> {
    this.requests.push(request);
    const page = this.data
      .filter(
        (c) => c.tf === request.tf && c.openTimeMs >= request.fromMs && c.openTimeMs < request.toMs,
      )
      .map((c) => ({ ...c, closed: this.clock.now() >= c.openTimeMs + TIMEFRAME_MS[c.tf] }));
    if (page.length > 0) yield page;
  }
  async fetchMarkets() {
    return [];
  }
  health(): ProviderHealth {
    return this.healthy;
  }
}

const candleAt = (tf: RawCandle['tf'], openTimeMs: number, price: number): RawCandle => ({
  venueSymbol: 'BTCUSDT',
  marketType: 'PERP',
  tf,
  openTimeMs,
  o: String(price),
  h: String(price + 1),
  l: String(price - 1),
  c: String(price),
  v: '5',
  closed: true,
  receivedAtMs: 0,
});
const minute = (m: number) => candleAt('1m', BASE + m * MIN, 100);

let server: TestServer;
let sql: Sql;
let store: CandleStore;
let registry: InstrumentRegistry;

beforeAll(async () => {
  server = await startTestServer();
  sql = createClient(await server.createDatabase(), { max: 5 });
  await applyMigrations(sql, { withShims: true });
  store = new CandleStore(sql);
  registry = await InstrumentRegistry.load(sql);
}, 180_000);
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await server.stop();
});

const count = async (where = sql``) => {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from candles ${where}`;
  return row?.n ?? 0;
};

describe('BackfillService and seeding', () => {
  let clock: FakeClock;
  let venue: FakeVenue;
  let bus: InMemoryEventBus;
  let queue: InMemoryJobQueue;
  let ingest: IngestService;
  let backfill: BackfillService;
  let events: { name: string; payload: unknown }[];
  const instrument = () => registry.forVenueSymbol('binance', 'PERP', 'BTCUSDT');
  const id = () => instrument()?.id ?? '';

  beforeEach(async () => {
    await sql`truncate candles, candle_quarantine, candle_gaps, dq_incidents`;
    clock = new FakeClock();
    venue = new FakeVenue(clock);
    bus = new InMemoryEventBus();
    queue = new InMemoryJobQueue();
    events = [];
    for (const name of [
      'candle.closed',
      'candle.backfilled',
      'dq.incident',
      'feed.status',
    ] as const) {
      bus.subscribe(name, (payload: BusEvents[typeof name]) => {
        events.push({ name, payload });
      });
    }
    const log = { warn: () => {}, info: () => {} };
    ingest = new IngestService(store, registry, bus, queue, clock, log, {
      incompleteTimeoutMs: 90_000,
    });
    backfill = new BackfillService(
      store,
      registry,
      new Map([['binance', venue]]),
      ingest,
      bus,
      queue,
      clock,
      log,
    );
    await backfill.register();
  });

  it('fills a gap, resolves it, completes the 5m candle and announces the range once', async () => {
    for (const m of [0, 1, 4]) await ingest.handleRaw('binance', minute(m), 'live');
    const [job] = queue.enqueued;
    expect(job?.name).toBe('md.backfill');
    venue.data = [minute(2), minute(3)];

    await queue.drain('md.backfill');
    expect(await count(sql`where tf = '1m'`)).toBe(5);
    const [five] = await store.range(id(), '5m', BASE, BASE + 5 * MIN);
    expect(five).toMatchObject({ status: 'CLOSED', closed: true });
    const [gap] = await sql<{ status: string }[]>`select status from candle_gaps`;
    expect(gap?.status).toBe('RESOLVED');
    expect(events.filter((e) => e.name === 'candle.backfilled')).toHaveLength(1);
    expect(events.filter((e) => (e.payload as { source?: string }).source === 'backfill')).toEqual(
      [],
    );
    expect(
      (await store.range(id(), '1m', BASE + 2 * MIN, BASE + 4 * MIN)).every(
        (c) => c.flags & FLAG.BACKFILLED,
      ),
    ).toBe(true);
  });

  it('is idempotent: running the same job again changes nothing', async () => {
    for (const m of [0, 1, 4]) await ingest.handleRaw('binance', minute(m), 'live');
    venue.data = [minute(2), minute(3)];
    const job = { instrumentId: id(), fromMs: BASE + 2 * MIN, toMs: BASE + 4 * MIN };
    await backfill.run(job);
    const before = await count();
    await backfill.run(job);
    expect(await count()).toBe(before);
  });

  it('fails (so the queue retries) while minutes are still missing, and keeps the gap open', async () => {
    for (const m of [0, 1, 4]) await ingest.handleRaw('binance', minute(m), 'live');
    venue.data = [minute(2)]; // minute 3 not available yet
    await expect(
      backfill.run({ instrumentId: id(), fromMs: BASE + 2 * MIN, toMs: BASE + 4 * MIN }),
    ).rejects.toBeInstanceOf(BackfillIncompleteError);
    const [gap] = await sql<{ status: string }[]>`select status from candle_gaps`;
    expect(gap?.status).toBe('BACKFILLING');
    expect(events.filter((e) => e.name === 'candle.backfilled')).toEqual([]);
  });

  it('gives up cleanly on an old range the venue has no data for', async () => {
    await ingest.handleRaw('binance', minute(0), 'live');
    await ingest.handleRaw('binance', minute(3), 'live');
    venue.data = [];
    await backfill.run({ instrumentId: id(), fromMs: BASE + MIN, toMs: BASE + 3 * MIN });
    const [gap] = await sql<{ status: string }[]>`select status from candle_gaps`;
    expect(gap?.status).toBe('UNRESOLVABLE');
  });

  describe('reconcile', () => {
    const HOUR = 3_600_000;
    const lastHours = (n: number) => {
      const top = Math.floor(clock.now() / HOUR) * HOUR;
      return Array.from({ length: n }, (_, i) => top - (i + 1) * HOUR);
    };
    const insertOurs = async (open: number, price: number) => {
      await store.ensurePartitions(open, open);
      await store.insertCandle({
        instrumentId: id(),
        tf: '1h',
        openTime: open,
        o: price,
        h: price + 1,
        l: price - 1,
        c: price,
        v: 1,
        closed: true,
        providerId: 'binance',
        flags: 0,
        status: 'CLOSED',
      });
    };

    it('is quiet when our aggregated candles match the venue', async () => {
      for (const open of lastHours(5)) {
        await insertOurs(open, 100);
        venue.data.push(candleAt('1h', open, 100));
      }
      const report = await backfill.reconcile(
        instrument() as NonNullable<ReturnType<typeof instrument>>,
      );
      expect(report).toMatchObject({ compared: 5, differences: [] });
      expect(await sql`select 1 from dq_incidents where rule = 'RECONCILE'`).toHaveLength(0);
    });

    it('opens a RECONCILE incident for a real difference and changes nothing', async () => {
      const [a, b] = lastHours(2) as [number, number];
      await insertOurs(a, 100);
      await insertOurs(b, 100);
      venue.data.push(candleAt('1h', a, 100), candleAt('1h', b, 105)); // the venue disagrees on b
      const report = await backfill.reconcile(
        instrument() as NonNullable<ReturnType<typeof instrument>>,
      );
      expect(report.differences.length).toBeGreaterThan(0);
      expect(report.differences[0]).toMatchObject({ tf: '1h', ours: 100, venue: 105 });
      expect(
        await sql`select 1 from dq_incidents where rule = 'RECONCILE' and closed_at is null`,
      ).toHaveLength(1);
      expect((await store.range(id(), '1h', b, b + HOUR))[0]?.c).toBe(100); // never overwritten
    });

    it('is scheduled nightly at 03:00 UTC', () => {
      expect(queue.schedules).toEqual([{ name: 'md.reconcile', cron: '0 3 * * *' }]);
    });
  });

  describe('seed', () => {
    const history = () => {
      const out: RawCandle[] = [];
      const todayStart = (tfMs: number) => Math.floor(clock.now() / tfMs) * tfMs;
      for (const [tf, bars] of [
        ['1d', 400],
        ['4h', 500],
        ['1h', 800],
        ['15m', 1000],
        ['5m', 1000],
      ] as const) {
        const ms = TIMEFRAME_MS[tf];
        for (let i = 1; i <= bars; i++) out.push(candleAt(tf, todayStart(ms) - i * ms, 100));
      }
      return out;
    };

    it('stores native higher-timeframe history, queues the recent 1m window, and is repeatable', async () => {
      venue.data = history();
      await backfill.seed(instrument() as NonNullable<ReturnType<typeof instrument>>);
      expect(await count(sql`where tf = '1d'`)).toBe(400);
      expect(await count(sql`where tf = '4h'`)).toBe(500);
      expect(await count(sql`where tf = '1h'`)).toBe(800);
      expect(await count(sql`where tf = '5m'`)).toBe(1000);
      expect(await count(sql`where status <> 'CLOSED' or (flags & ${FLAG.BACKFILLED}) = 0`)).toBe(
        0,
      );
      expect(queue.enqueued.filter((j) => j.name === 'md.backfill')).toHaveLength(1);

      const requestsBefore = venue.requests.length;
      await backfill.seed(instrument() as NonNullable<ReturnType<typeof instrument>>);
      expect(venue.requests.length).toBe(requestsBefore); // already warm: no venue calls for higher timeframes
      expect(await count()).toBe(400 + 500 + 800 + 1000 + 1000);
    });

    it('never stores the bucket that is still forming', async () => {
      const tfMs = TIMEFRAME_MS['1h'];
      const current = Math.floor(clock.now() / tfMs) * tfMs;
      venue.data = [candleAt('1h', current, 100)];
      await backfill.seed(instrument() as NonNullable<ReturnType<typeof instrument>>);
      expect(await count(sql`where tf = '1h' and open_time = ${new Date(current)}`)).toBe(0);
    });
  });
});

describe('FeedMonitor', () => {
  it('goes OK -> DEGRADED -> STALE, publishes each change once and records the stale incident', async () => {
    await sql`truncate candles, candle_quarantine, candle_gaps, dq_incidents`;
    const clock = new FakeClock();
    const bus = new InMemoryEventBus();
    const events: { name: string; payload: unknown }[] = [];
    bus.subscribe('feed.status', (p) => events.push({ name: 'feed.status', payload: p }));
    bus.subscribe('dq.incident', (p) => events.push({ name: 'dq.incident', payload: p }));
    const queue = new InMemoryJobQueue();
    const ingest = new IngestService(store, registry, bus, queue, clock, {
      warn: () => {},
      info: () => {},
    });
    const instrument = registry.forVenueSymbol('binance', 'PERP', 'BTCUSDT');
    if (!instrument) throw new Error('seed missing');
    const venue = new FakeVenue(clock);
    const monitor = new FeedMonitor(
      [{ instrument, health: () => venue.health() }],
      ingest,
      store,
      bus,
      clock,
      { warn: () => {}, info: () => {} },
    );

    const last = Math.floor(clock.now() / MIN) * MIN - 2 * MIN; // last closed minute
    clock.nowMs = last + 2 * MIN + 1000; // 1 s after the next one should have closed
    await ingest.handleRaw('binance', candleAt('1m', last, 100), 'live');
    venue.healthy = { connected: true, lastMessageAtMs: clock.nowMs - 500, reconnects: 0 };
    await monitor.tick();
    expect(monitor.statusOf(instrument.id)?.state).toBe('OK');

    clock.nowMs += 16_000; // silence
    await monitor.tick();
    expect(monitor.statusOf(instrument.id)).toMatchObject({
      state: 'DEGRADED',
      reasons: ['SILENT'],
    });

    clock.nowMs += 10_000; // candle overdue
    await monitor.tick();
    expect(monitor.statusOf(instrument.id)?.state).toBe('STALE');
    expect(
      await sql`select 1 from dq_incidents where rule = 'FEED_STALE' and closed_at is null`,
    ).toHaveLength(1);

    await monitor.tick(); // nothing changed: no duplicate event
    expect(
      events
        .filter((e) => e.name === 'feed.status')
        .map((e) => (e.payload as { state: string }).state),
    ).toEqual(['OK', 'DEGRADED', 'STALE']);

    // Recovery: a fresh candle and live frames.
    clock.nowMs += MIN;
    await ingest.handleRaw(
      'binance',
      candleAt('1m', Math.floor((clock.nowMs - MIN) / MIN) * MIN, 100),
      'live',
    );
    venue.healthy = { connected: true, lastMessageAtMs: clock.nowMs - 200, reconnects: 1 };
    await monitor.tick();
    expect(monitor.statusOf(instrument.id)?.state).toBe('OK');
    expect(
      await sql`select 1 from dq_incidents where rule = 'FEED_STALE' and closed_at is null`,
    ).toHaveLength(0);
  });
});
