import { createHash } from 'node:crypto';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import { FLAG, type ProviderId, type RawCandle } from '@smc/market-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CandleStore } from '../src/ingest/candle-store.js';
import { type BusEvents, InMemoryEventBus } from '../src/ingest/event-bus.js';
import { type Clock, IngestService } from '../src/ingest/ingest.service.js';
import { InstrumentRegistry } from '../src/ingest/instrument-registry.js';
import { InMemoryJobQueue } from '../src/ingest/job-queue.js';

const MIN = 60_000;
const BASE = Date.UTC(2026, 9, 11, 12, 0); // 12:00 UTC, aligned to every timeframe up to 4h

class FakeClock implements Clock {
  nowMs = BASE + 6 * 3_600_000;
  private timers: { at: number; fn: () => void }[] = [];
  now = () => this.nowMs;
  setTimeout(fn: () => void, ms: number): () => void {
    const t = { at: this.nowMs + ms, fn };
    this.timers.push(t);
    return () => {
      this.timers = this.timers.filter((x) => x !== t);
    };
  }
  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers.filter((t) => t.at <= this.nowMs);
    this.timers = this.timers.filter((t) => t.at > this.nowMs);
    for (const t of due) t.fn();
  }
}

let server: TestServer;
let sql: Sql;
let store: CandleStore;
let registry: InstrumentRegistry;

beforeAll(async () => {
  server = await startTestServer();
  const url = await server.createDatabase();
  sql = createClient(url, { max: 5 });
  await applyMigrations(sql, { withShims: true });
  store = new CandleStore(sql);
  registry = await InstrumentRegistry.load(sql);
}, 180_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await server.stop();
});

const raw = (
  symbol: string,
  marketType: 'SPOT' | 'PERP',
  minute: number,
  px: { o?: number; h?: number; l?: number; c?: number; v?: number } = {},
  closed = true,
): RawCandle => {
  // Continuous series by default (each open equals the previous close) so V9 stays quiet unless a test wants it.
  const o = px.o ?? px.c ?? Number((100 + minute / 10).toFixed(1));
  const c = px.c ?? Number((o + 0.1).toFixed(1));
  return {
    venueSymbol: symbol,
    marketType,
    tf: '1m',
    openTimeMs: BASE + minute * MIN,
    o: String(o),
    h: String(px.h ?? Math.max(o, c) + 1),
    l: String(px.l ?? Math.min(o, c) - 1),
    c: String(c),
    v: String(px.v ?? 10),
    closed,
    receivedAtMs: BASE + (minute + 1) * MIN + 500,
  };
};

interface Harness {
  clock: FakeClock;
  bus: InMemoryEventBus;
  queue: InMemoryJobQueue;
  ingest: IngestService;
  events: { name: string; payload: unknown }[];
  feed(
    provider: ProviderId,
    r: RawCandle,
    source?: 'live' | 'backfill',
  ): ReturnType<IngestService['handleRaw']>;
}

const btcPerp = () => registry.forVenueSymbol('binance', 'PERP', 'BTCUSDT');
const btcSpot = () => registry.forVenueSymbol('binance', 'SPOT', 'BTCUSDT');
const _bybitBtc = () => registry.forVenueSymbol('bybit', 'PERP', 'BTCUSDT');

async function harness(): Promise<Harness> {
  await sql`truncate candles, candle_quarantine, candle_gaps, dq_incidents`;
  const clock = new FakeClock();
  const bus = new InMemoryEventBus();
  const events: { name: string; payload: unknown }[] = [];
  for (const name of [
    'candle.closed',
    'candle.backfilled',
    'feed.status',
    'dq.incident',
  ] as const) {
    bus.subscribe(name, (payload: BusEvents[typeof name]) => {
      events.push({ name, payload });
    });
  }
  const queue = new InMemoryJobQueue();
  const log = { warn: () => {}, info: () => {} };
  const ingest = new IngestService(store, registry, bus, queue, clock, log, {
    incompleteTimeoutMs: 90_000,
  });
  return {
    clock,
    bus,
    queue,
    ingest,
    events,
    feed: (provider, r, source = 'live') => ingest.handleRaw(provider, r, source),
  };
}

const count = async (table: string, where = sql``) => {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} ${where}`;
  return row?.n ?? 0;
};

describe('registry', () => {
  it('maps venue symbols to instruments by provider and market type, never mixing spot and perp', () => {
    expect(btcPerp()?.canonical).toBe('BINANCE:PERP:BTCUSDT');
    expect(btcSpot()?.canonical).toBe('BINANCE:SPOT:BTCUSDT');
    expect(btcPerp()?.id).not.toBe(btcSpot()?.id);
    expect(registry.forVenueSymbol('binance', 'PERP', 'DOGEUSDT')).toBeUndefined();
  });

  it('pairs cross-check peers of the same market type only', () => {
    expect(registry.peerOf(btcPerp()?.id ?? '')?.canonical).toBe('BYBIT:PERP:BTCUSDT');
    expect(registry.peerOf(btcSpot()?.id ?? '')).toBeUndefined(); // spot has no peer at MVP: NO_PEER, not "verified"
  });
});

describe('IngestService', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('stores a validated 1m candle and publishes only after the commit (a consumer sees the row)', async () => {
    const seen: number[] = [];
    h.bus.subscribe('candle.closed', async (e) => {
      if (e.tf === '1m')
        seen.push(await count('candles', sql`where instrument_id = ${e.instrumentId}`));
    });
    expect(await h.feed('binance', raw('BTCUSDT', 'PERP', 0))).toEqual({ kind: 'stored' });
    await h.ingest.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([1]);
    const rows = await store.range(btcPerp()?.id ?? '', '1m', BASE, BASE + MIN);
    expect(rows[0]).toMatchObject({
      o: 100,
      c: 100.1,
      flags: 0,
      status: 'CLOSED',
      providerId: 'binance',
    });
  });

  it('ignores forming candles', async () => {
    expect(await h.feed('binance', raw('BTCUSDT', 'PERP', 0, {}, false))).toEqual({
      kind: 'forming',
    });
    expect(await count('candles')).toBe(0);
  });

  it('keeps spot and perp series apart', async () => {
    await h.feed('binance', raw('BTCUSDT', 'SPOT', 0, { o: 100, c: 101 }));
    await h.feed('binance', raw('BTCUSDT', 'PERP', 0, { o: 200, c: 201 }));
    expect((await store.range(btcSpot()?.id ?? '', '1m', BASE, BASE + MIN))[0]?.o).toBe(100);
    expect((await store.range(btcPerp()?.id ?? '', '1m', BASE, BASE + MIN))[0]?.o).toBe(200);
  });

  describe('rejects into quarantine', () => {
    it.each([
      ['bad OHLC', { h: 90 }, 'BAD_OHLC'],
      ['non-positive price', { l: 0 }, 'NON_POSITIVE'],
    ])('%s', async (_label, px, reason) => {
      expect(await h.feed('binance', raw('BTCUSDT', 'PERP', 0, px))).toEqual({
        kind: 'quarantined',
        reason,
      });
      expect(await count('candles')).toBe(0);
      const [row] = await sql<
        { reason: string; instrument_id: string }[]
      >`select reason, instrument_id from candle_quarantine`;
      expect(row).toMatchObject({ reason, instrument_id: btcPerp()?.id });
    });

    it('misaligned and future candles', async () => {
      const misaligned = { ...raw('BTCUSDT', 'PERP', 0), openTimeMs: BASE + 1 };
      expect(await h.feed('binance', misaligned)).toEqual({
        kind: 'quarantined',
        reason: 'MISALIGNED',
      });
      const future = raw('BTCUSDT', 'PERP', 24 * 60);
      expect(await h.feed('binance', future)).toEqual({ kind: 'quarantined', reason: 'FUTURE_TS' });
    });

    it('an unmapped symbol is counted and never guessed', async () => {
      expect(await h.feed('binance', raw('DOGEUSDT', 'PERP', 0))).toEqual({ kind: 'unmapped' });
      expect(await count('candle_quarantine', sql`where reason = 'UNMAPPED_SYMBOL'`)).toBe(1);
    });

    it('a conflicting duplicate keeps the first value and raises an incident', async () => {
      await h.feed('binance', raw('BTCUSDT', 'PERP', 0));
      expect(await h.feed('binance', raw('BTCUSDT', 'PERP', 0, { c: 150, h: 151 }))).toEqual({
        kind: 'quarantined',
        reason: 'CONFLICTING_DUPLICATE',
      });
      expect((await store.range(btcPerp()?.id ?? '', '1m', BASE, BASE + MIN))[0]?.c).toBe(100.1);
      expect(await count('dq_incidents', sql`where rule = 'V5' and closed_at is null`)).toBe(1);
    });
  });

  it('a V5 conflict incident closes itself after five clean candles and no longer leaves the feed degraded', async () => {
    await h.feed('binance', raw('BTCUSDT', 'PERP', 0));
    await h.feed('binance', raw('BTCUSDT', 'PERP', 0, { c: 150, h: 151 })); // conflict
    expect(h.ingest.stateSnapshot(btcPerp()?.id ?? '').incidentOpen).toBe(true);
    for (let m = 1; m <= 5; m++) await h.feed('binance', raw('BTCUSDT', 'PERP', m));
    expect(h.ingest.stateSnapshot(btcPerp()?.id ?? '').incidentOpen).toBe(false);
    expect(await count('dq_incidents', sql`where closed_at is null`)).toBe(0);
  });

  it('a FEED_STALE row left open by a previous process does not count as a data-quality incident', async () => {
    await sql`insert into dq_incidents (instrument_id, venue_id, rule) values (${btcPerp()?.id}, 'BINANCE', 'FEED_STALE')`;
    await h.feed('binance', raw('BTCUSDT', 'PERP', 0));
    expect(h.ingest.stateSnapshot(btcPerp()?.id ?? '').incidentOpen).toBe(false);
  });

  it('an identical repeat is a harmless no-op (idempotent)', async () => {
    await h.feed('binance', raw('BTCUSDT', 'PERP', 0));
    expect(await h.feed('binance', raw('BTCUSDT', 'PERP', 0))).toEqual({ kind: 'duplicate' });
    expect(await count('candles')).toBe(1);
  });

  describe('higher timeframes', () => {
    it('writes the 5m candle in the same pass as the minute that closes it, with correct OHLCV', async () => {
      for (let m = 0; m < 5; m++)
        await h.feed(
          'binance',
          raw('BTCUSDT', 'PERP', m, { o: 100 + m, c: 101 + m, h: 110 + m, l: 90 - m, v: 2 }),
        );
      const [five] = await store.range(btcPerp()?.id ?? '', '5m', BASE, BASE + 5 * MIN);
      expect(five).toMatchObject({ o: 100, c: 105, h: 114, l: 86, v: 10, status: 'CLOSED' });
      const closed = h.events
        .filter((e) => e.name === 'candle.closed')
        .map((e) => (e.payload as BusEvents['candle.closed']).tf);
      expect(closed.slice(-2)).toEqual(['1m', '5m']); // the 1m event comes before the 5m it completes
    });

    it('builds 15m, 1h and 4h candles that equal the fold of their minutes', async () => {
      for (let m = 0; m < 240; m++) await h.feed('binance', raw('BTCUSDT', 'PERP', m, { v: 1 }));
      const id = btcPerp()?.id ?? '';
      expect(await count('candles', sql`where instrument_id = ${id} and tf = '5m'`)).toBe(48);
      expect(await count('candles', sql`where instrument_id = ${id} and tf = '15m'`)).toBe(16);
      expect(await count('candles', sql`where instrument_id = ${id} and tf = '1h'`)).toBe(4);
      const [fourH] = await store.range(id, '4h', BASE, BASE + 4 * 3_600_000);
      expect(fourH).toMatchObject({ o: 100, c: 124, v: 240, status: 'CLOSED' });
    });
  });

  describe('gaps and backfill', () => {
    it('detects a missing minute, records it and enqueues one backfill job', async () => {
      await h.feed('binance', raw('BTCUSDT', 'PERP', 0));
      await h.feed('binance', raw('BTCUSDT', 'PERP', 1));
      await h.feed('binance', raw('BTCUSDT', 'PERP', 4));
      const [gap] = await sql<
        { from_time: Date; to_time: Date; status: string }[]
      >`select from_time, to_time, status from candle_gaps`;
      expect(gap?.from_time.getTime()).toBe(BASE + 2 * MIN);
      expect(gap?.to_time.getTime()).toBe(BASE + 3 * MIN);
      expect(gap?.status).toBe('OPEN');
      expect(h.queue.enqueued).toMatchObject([
        {
          name: 'md.backfill',
          data: { fromMs: BASE + 2 * MIN, toMs: BASE + 4 * MIN },
          options: { singletonKey: `${btcPerp()?.id}:${BASE + 2 * MIN}` },
        },
      ]);
    });

    it('never closes a 5m candle with a missing minute: INCOMPLETE after the wait, CLOSED after the backfill', async () => {
      const id = btcPerp()?.id ?? '';
      for (const m of [0, 1, 3, 4]) await h.feed('binance', raw('BTCUSDT', 'PERP', m));
      expect(await count('candles', sql`where tf = '5m'`)).toBe(0); // held while a backfill may still arrive

      h.clock.advance(89_000);
      await h.ingest.idle();
      expect(await count('candles', sql`where tf = '5m'`)).toBe(0);
      h.clock.advance(2_000);
      await new Promise((r) => setTimeout(r, 200));
      await h.ingest.idle();
      const [incomplete] = await store.range(id, '5m', BASE, BASE + 5 * MIN);
      expect(incomplete).toMatchObject({ status: 'INCOMPLETE', closed: false });
      const published = h.events.filter(
        (e) => e.name === 'candle.closed' && (e.payload as BusEvents['candle.closed']).tf === '5m',
      );
      expect(published[0]?.payload).toMatchObject({ status: 'INCOMPLETE' });

      await h.feed('binance', raw('BTCUSDT', 'PERP', 2), 'backfill');
      const [closed] = await store.range(id, '5m', BASE, BASE + 5 * MIN);
      expect(closed).toMatchObject({ status: 'CLOSED', closed: true });
      expect(closed?.flags ?? 0).toBe(FLAG.BACKFILLED);
      // A backfill is announced once for its range by BackfillService, never candle by candle.
      expect(
        h.events.filter((e) => (e.payload as { source?: string }).source === 'backfill'),
      ).toEqual([]);
      const minute2 = (await store.range(id, '1m', BASE + 2 * MIN, BASE + 3 * MIN))[0];
      expect(minute2?.flags).toBe(FLAG.BACKFILLED);
    });

    it('stores an INCOMPLETE 5m candle for a bucket the stream skipped past, even if the backfill never arrives', async () => {
      for (const m of [0, 1, 2, 3]) await h.feed('binance', raw('BTCUSDT', 'PERP', m));
      await h.feed('binance', raw('BTCUSDT', 'PERP', 7)); // minute 4 (which would close 0-4) never arrived
      expect(await count('candles', sql`where tf = '5m'`)).toBe(0);
      h.clock.advance(91_000);
      await new Promise((r) => setTimeout(r, 200));
      await h.ingest.idle();
      const [five] = await store.range(btcPerp()?.id ?? '', '5m', BASE, BASE + 5 * MIN);
      expect(five).toMatchObject({ status: 'INCOMPLETE' });
    });

    it('does not report a gap while a backfill is already filling that instrument', async () => {
      await h.feed('binance', raw('BTCUSDT', 'PERP', 0));
      await h.ingest.withBackfillActive(btcPerp()?.id ?? '', async () => {
        await h.feed('binance', raw('BTCUSDT', 'PERP', 5));
      });
      expect(await count('candle_gaps')).toBe(0);
      expect(h.queue.enqueued).toEqual([]);
    });

    it('an out-of-order live minute completes the bucket without a gap or a pending timer', async () => {
      for (const m of [0, 1, 2, 3, 5, 4]) await h.feed('binance', raw('BTCUSDT', 'PERP', m));
      expect(await count('candle_gaps')).toBe(1); // minute 4 was skipped when 5 arrived: that is a real gap at that moment
      const [five] = await store.range(btcPerp()?.id ?? '', '5m', BASE, BASE + 5 * MIN);
      expect(five?.status).toBe('CLOSED');
    });

    it('a backfill that arrives before anything else leaves no duplicate rows', async () => {
      for (let m = 0; m < 10; m++) await h.feed('binance', raw('BTCUSDT', 'PERP', m), 'backfill');
      for (let m = 0; m < 10; m++) await h.feed('binance', raw('BTCUSDT', 'PERP', m), 'live');
      expect(await count('candles', sql`where tf = '1m'`)).toBe(10);
      expect(await count('candles', sql`where tf = '5m'`)).toBe(2);
    });
  });

  describe('cross-check (V7)', () => {
    const flagOf = async (minute: number) =>
      (
        await store.range(btcPerp()?.id ?? '', '1m', BASE + minute * MIN, BASE + (minute + 1) * MIN)
      )[0]?.flags ?? -1;

    it('agrees within tolerance regardless of which venue arrives first', async () => {
      await h.feed('binance', raw('BTCUSDT', 'PERP', 0, { c: 100 }));
      await h.feed('bybit', raw('BTCUSDT', 'PERP', 0, { c: 100.05 }));
      await h.feed('bybit', raw('BTCUSDT', 'PERP', 1, { c: 100 }));
      await h.feed('binance', raw('BTCUSDT', 'PERP', 1, { c: 100.05 }));
      expect(await flagOf(0)).toBe(0);
      expect(await flagOf(1)).toBe(0);
      expect(await count('dq_incidents')).toBe(0);
    });

    it('a divergence flags the candle and opens an incident when the peer arrives second', async () => {
      await h.feed('binance', raw('BTCUSDT', 'PERP', 0, { c: 100 }));
      await h.feed('bybit', raw('BTCUSDT', 'PERP', 0, { c: 100.5, h: 101.5 }));
      expect(await flagOf(0)).toBe(FLAG.CROSSCHECK_DIVERGENCE);
      expect(await count('dq_incidents', sql`where rule = 'V7' and closed_at is null`)).toBe(1);
      expect(h.ingest.stateSnapshot(btcPerp()?.id ?? '').incidentOpen).toBe(true);
    });

    it('a divergence is flagged when the peer arrives first as well', async () => {
      await h.feed('bybit', raw('BTCUSDT', 'PERP', 0, { c: 100.5, h: 101.5 }));
      await h.feed('binance', raw('BTCUSDT', 'PERP', 0, { c: 100 }));
      expect(await flagOf(0)).toBe(FLAG.CROSSCHECK_DIVERGENCE);
      expect(await count('dq_incidents', sql`where rule = 'V7'`)).toBe(1);
    });

    it('closes the incident after five consecutive agreeing candles', async () => {
      await h.feed('binance', raw('BTCUSDT', 'PERP', 0, { c: 100 }));
      await h.feed('bybit', raw('BTCUSDT', 'PERP', 0, { c: 101, h: 102 }));
      for (let m = 1; m <= 5; m++) {
        await h.feed('binance', raw('BTCUSDT', 'PERP', m, { c: 100 }));
        await h.feed('bybit', raw('BTCUSDT', 'PERP', m, { c: 100.02 }));
      }
      expect(await count('dq_incidents', sql`where closed_at is null`)).toBe(0);
      expect(h.ingest.stateSnapshot(btcPerp()?.id ?? '').incidentOpen).toBe(false);
    });

    it('spot candles are never compared with a perp peer', async () => {
      await h.feed('binance', raw('BTCUSDT', 'SPOT', 0, { c: 100 }));
      await h.feed('bybit', raw('BTCUSDT', 'PERP', 0, { c: 150, h: 151 }));
      expect((await store.range(btcSpot()?.id ?? '', '1m', BASE, BASE + MIN))[0]?.flags).toBe(0);
      expect(await count('dq_incidents')).toBe(0);
    });
  });

  it('replaying the same input twice leaves identical rows (hash equal)', async () => {
    const run = async () => {
      for (let m = 0; m < 30; m++) await h.feed('binance', raw('BTCUSDT', 'PERP', m));
      const rows =
        await sql`select tf, open_time, o, h, l, c, v, status, flags from candles order by instrument_id, tf, open_time`;
      return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };
    const first = await run();
    const n = await count('candles');
    const second = await run();
    expect(second).toBe(first);
    expect(await count('candles')).toBe(n);
  });

  it('serialises concurrent arrivals for one instrument (no lost update, no duplicate)', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, m) => h.feed('binance', raw('BTCUSDT', 'PERP', m % 20))),
    );
    expect(results.filter((r) => r.kind === 'stored')).toHaveLength(20);
    expect(results.filter((r) => r.kind === 'duplicate')).toHaveLength(20);
    expect(await count('candles', sql`where tf = '1m'`)).toBe(20);
  });
});
