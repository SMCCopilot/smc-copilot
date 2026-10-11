import { type Candle, TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import { createEngine, type EngineEvent, feed } from '@smc/smc-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineRunner } from '../src/engine/engine.runner.js';
import { EngineStore } from '../src/engine/engine.store.js';
import { CandleStore } from '../src/ingest/candle-store.js';
import { type BusEvents, InMemoryEventBus } from '../src/ingest/event-bus.js';
import { InstrumentRegistry } from '../src/ingest/instrument-registry.js';

const START = Date.UTC(2026, 9, 12); // Monday 00:00 UTC
const TFS: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

let server: TestServer;
let sql: Sql;
let candles: CandleStore;
let instrument: { id: string; canonical: string };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 5m random walk aggregated to the analysis timeframes; only complete buckets. */
function generate(canonical: string, bars5m: number, from = START, seed = 3): Candle[] {
  const rnd = mulberry32(seed);
  const base: Candle[] = [];
  let price = 60_000;
  for (let i = 0; i < bars5m; i++) {
    const o = price;
    const c = Math.max(1000, o + Math.floor((rnd() - 0.5) * 160));
    price = c;
    base.push({
      instrumentId: canonical,
      tf: '5m',
      openTime: from + i * 300_000,
      o,
      h: Math.max(o, c) + Math.floor(rnd() * 50),
      l: Math.max(1, Math.min(o, c) - Math.floor(rnd() * 50)),
      c,
      v: 1,
      closed: true,
      providerId: 'binance',
    });
  }
  const out: Candle[] = [...base];
  for (const tf of TFS.filter((t) => t !== '5m')) {
    const ms = TIMEFRAME_MS[tf];
    const per = ms / 300_000;
    for (let t = from; ; t += ms) {
      const i = (t - from) / 300_000;
      if (i + per > base.length) break;
      const s = base.slice(i, i + per);
      out.push({
        ...(s[0] as Candle),
        tf,
        openTime: t,
        h: Math.max(...s.map((x) => x.h)),
        l: Math.min(...s.map((x) => x.l)),
        c: (s[s.length - 1] as Candle).c,
        v: s.length,
      });
    }
  }
  return out;
}

async function insert(list: readonly Candle[]): Promise<void> {
  for (const c of list) {
    await candles.insertCandle({
      instrumentId: instrument.id,
      tf: c.tf,
      openTime: c.openTime,
      o: c.o,
      h: c.h,
      l: c.l,
      c: c.c,
      v: c.v,
      closed: true,
      providerId: c.providerId,
      flags: 0,
      status: 'CLOSED',
    });
  }
}

async function replayFromDb(): Promise<EngineEvent[]> {
  const strategy = await new EngineStore(sql).activeStrategy();
  const all: Candle[] = [];
  for (const tf of TFS) {
    for (const r of await candles.closedAfter(instrument.id, tf, undefined, 100_000)) {
      all.push({ ...r, instrumentId: instrument.canonical, closed: true });
    }
  }
  return feed(createEngine(instrument.canonical), all, strategy?.config as never).events;
}

const dbEventIds = async (includeRetracted = false): Promise<string[]> =>
  (
    await sql<{ event_id: string }[]>`
      select event_id from engine_events
       where instrument_id = ${instrument.id} ${includeRetracted ? sql`` : sql`and not retracted`}
       order by event_id`
  ).map((r) => r.event_id);

beforeAll(async () => {
  server = await startTestServer();
  sql = createClient(await server.createDatabase(), { max: 5 });
  await applyMigrations(sql, { withShims: true });
  candles = new CandleStore(sql);
  const registry = await InstrumentRegistry.load(sql);
  const i = registry.forVenueSymbol('binance', 'PERP', 'BTCUSDT');
  if (!i) throw new Error('seed instrument missing');
  instrument = { id: i.id, canonical: i.canonical };
  await candles.ensurePartitions(START - 86_400_000, START + 30 * 86_400_000);
}, 180_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await server.stop();
});

interface Rig {
  bus: InMemoryEventBus;
  runner: EngineRunner;
  updates: BusEvents['engine.updated'][];
  notify(): void;
}

async function rig(batch?: number, coldStartBars?: number): Promise<Rig> {
  const bus = new InMemoryEventBus();
  const updates: BusEvents['engine.updated'][] = [];
  bus.subscribe('engine.updated', (e) => {
    updates.push(e);
  });
  const runner = new EngineRunner(
    sql,
    bus,
    candles,
    { warn: () => {}, info: () => {} },
    { batch, coldStartBars },
  );
  expect(await runner.start()).toBe(true);
  return {
    bus,
    runner,
    updates,
    notify: () =>
      bus.publish('candle.closed', {
        instrumentId: instrument.id,
        canonical: instrument.canonical,
        tf: '5m',
        openTime: START,
        status: 'CLOSED',
        source: 'live',
      }),
  };
}

beforeEach(async () => {
  await sql`truncate engine_events, engine_snapshots`;
  await sql`delete from candles where instrument_id = ${instrument.id}`;
});

describe('EngineRunner', () => {
  it('stores exactly the events a pure replay of the same candles produces', async () => {
    const data = generate(instrument.canonical, 288 * 3);
    await insert(data);
    const expected = await replayFromDb();
    expect(expected.length).toBeGreaterThan(50);

    const r = await rig();
    r.notify();
    await r.runner.idle();
    expect(await dbEventIds()).toEqual(expected.map((e) => e.id).sort());
    expect(r.updates.at(-1)).toMatchObject({ canonical: instrument.canonical, rebuilt: false });
    const [snap] = await sql<{ as_of: Date }[]>`
      select as_of from engine_snapshots where instrument_id = ${instrument.id} order by as_of desc`;
    expect((snap?.as_of.getTime() ?? 1) % 3_600_000).toBe(0);
    await r.runner.stop();
  });

  it('catches up in small batches without breaking canonical order', async () => {
    const all = generate(instrument.canonical, 288 * 3);
    const cut = START + 288 * 300_000;
    await insert(all.filter((c) => c.openTime + TIMEFRAME_MS[c.tf] <= cut));
    const first = await rig();
    first.notify();
    await first.runner.idle();
    await first.runner.stop();

    await insert(all.filter((c) => c.openTime + TIMEFRAME_MS[c.tf] > cut));
    const small = await rig(40); // 40 candles per timeframe per pass; many passes
    small.notify();
    await small.runner.idle();
    const expected = await replayFromDb();
    expect(await dbEventIds()).toEqual(expected.map((e) => e.id).sort());
    await small.runner.stop();
  });

  it('cold start replays only the most recent window per timeframe', async () => {
    await insert(generate(instrument.canonical, 288 * 3));
    const r = await rig(undefined, 50);
    r.notify();
    await r.runner.idle();
    const state = r.runner.stateOf(instrument.id);
    expect(state?.perTf['5m']?.window.length).toBe(50);
    await r.runner.stop();
  });

  it('restarts from the snapshot without duplicates and keeps up with new candles', async () => {
    const all = generate(instrument.canonical, 288 * 3);
    const cut = START + 288 * 2 * 300_000 + 30 * 60_000; // half an hour past the last whole-hour snapshot
    await insert(all.filter((c) => c.openTime + TIMEFRAME_MS[c.tf] <= cut));
    const first = await rig();
    first.notify();
    await first.runner.idle();
    const before = await dbEventIds();
    await first.runner.stop();

    const second = await rig(); // fresh process: empty memory, hydrates from the snapshot
    second.notify();
    await second.runner.idle();
    expect(await dbEventIds()).toEqual(before);
    expect(second.updates.at(-1)?.events).toBe(0);

    await insert(all.filter((c) => c.openTime + TIMEFRAME_MS[c.tf] > cut));
    second.notify();
    await second.runner.idle();
    const expected = await replayFromDb();
    expect(await dbEventIds()).toEqual(expected.map((e) => e.id).sort());
    await second.runner.stop();
  });

  it('retries cleanly after a failed write: nothing half-written, state not advanced', async () => {
    await insert(generate(instrument.canonical, 288));
    const spy = vi
      .spyOn(EngineStore.prototype, 'persist')
      .mockRejectedValueOnce(new Error('db down'));
    const r = await rig();
    r.notify();
    await r.runner.idle();
    expect(r.runner.failures).toBe(1);
    expect(await dbEventIds()).toEqual([]);
    expect(r.runner.stateOf(instrument.id)?.lastCandleOpenTime).toEqual({});
    spy.mockRestore();

    r.notify();
    await r.runner.idle();
    const expected = await replayFromDb();
    expect(await dbEventIds()).toEqual(expected.map((e) => e.id).sort());
    await r.runner.stop();
  });

  it('rebuilds after a backfill: revised events bump revision, vanished events are retracted', async () => {
    await insert(generate(instrument.canonical, 288 * 3));
    const r = await rig();
    r.notify();
    await r.runner.idle();

    // A repaired 15m candle turns into a violent spike a day and a half in.
    const target = START + 36 * 3_600_000;
    await sql`
      update candles set h = h + 900, l = greatest(l - 900, 1)
       where instrument_id = ${instrument.id} and tf = '15m' and open_time = ${new Date(target)}`;
    r.bus.publish('candle.backfilled', {
      instrumentId: instrument.id,
      canonical: instrument.canonical,
      fromMs: target,
      toMs: target + 900_000,
    });
    await r.runner.idle();

    const expected = await replayFromDb();
    expect(await dbEventIds()).toEqual(expected.map((e) => e.id).sort());
    const [changed] = await sql<{ n: number }[]>`
      select count(*)::int as n from engine_events
       where instrument_id = ${instrument.id} and (revision > 0 or retracted)`;
    expect(changed?.n).toBeGreaterThan(0);
    expect(r.updates.at(-1)?.rebuilt).toBe(true);
    await r.runner.stop();
  });

  it('stays idle without an ACTIVE strategy version', async () => {
    await sql`update strategy_versions set status = 'RETIRED' where name = 'smc-core'`;
    try {
      const runner = new EngineRunner(sql, new InMemoryEventBus(), candles, {
        warn: () => {},
        info: () => {},
      });
      expect(await runner.start()).toBe(false);
    } finally {
      await sql`update strategy_versions set status = 'ACTIVE' where name = 'smc-core'`;
    }
  });
});

describe('EngineRunner hardening (review fixes)', () => {
  const pureFromDb = async () => {
    const strategy = await new EngineStore(sql).activeStrategy();
    const all: Candle[] = [];
    for (const tf of TFS) {
      for (const r of await candles.closedAfter(instrument.id, tf, undefined, 100_000)) {
        all.push({ ...r, instrumentId: instrument.canonical, closed: true });
      }
    }
    return feed(createEngine(instrument.canonical), all, strategy?.config as never);
  };

  it('holds exactly the state a pure replay produces, and publishes a close time as asOf', async () => {
    await insert(generate(instrument.canonical, 288 * 3));
    const r = await rig();
    r.notify();
    await r.runner.idle();
    const pure = await pureFromDb();
    expect(JSON.stringify(r.runner.stateOf(instrument.id))).toBe(JSON.stringify(pure.state));
    expect(r.updates.at(-1)?.asOf).toBe(START + 288 * 3 * 300_000); // the last 5m candle's CLOSE
    await r.runner.stop();
  });

  it('is healthy again after a failure once a later job succeeds', async () => {
    await insert(generate(instrument.canonical, 288));
    const spy = vi.spyOn(EngineStore.prototype, 'persist').mockRejectedValueOnce(new Error('x'));
    const r = await rig();
    r.notify();
    await r.runner.idle();
    expect(r.runner.failing.size).toBe(1);
    spy.mockRestore();
    r.notify();
    await r.runner.idle();
    expect(r.runner.failing.size).toBe(0);
    await r.runner.stop();
  });

  it('retries a failed rebuild on the next event instead of losing the repair', async () => {
    await insert(generate(instrument.canonical, 288 * 3));
    const r = await rig();
    r.notify();
    await r.runner.idle();

    const target = START + 36 * 3_600_000;
    await sql`
      update candles set h = h + 900, l = greatest(l - 900, 1)
       where instrument_id = ${instrument.id} and tf = '15m' and open_time = ${new Date(target)}`;
    const spy = vi.spyOn(EngineStore.prototype, 'persist').mockRejectedValueOnce(new Error('x'));
    r.bus.publish('candle.backfilled', {
      instrumentId: instrument.id,
      canonical: instrument.canonical,
      fromMs: target,
      toMs: target + 900_000,
    });
    await r.runner.idle();
    expect(r.runner.failing.size).toBe(1);
    spy.mockRestore();

    r.notify(); // any later candle event runs the pending rebuild first
    await r.runner.idle();
    expect(r.runner.failing.size).toBe(0);
    expect(await dbEventIds()).toEqual((await replayFromDb()).map((e) => e.id).sort());
    await r.runner.stop();
  });

  it('a rebuild with no snapshot never retracts events older than the window it replayed', async () => {
    await insert(generate(instrument.canonical, 288 * 3));
    const first = await rig();
    first.notify();
    await first.runner.idle();
    await first.runner.stop();
    const total5m = async () =>
      (
        await sql<{ n: number }[]>`
          select count(*)::int as n from engine_events
           where instrument_id = ${instrument.id} and tf = '5m' and not retracted
             and event_time <= ${new Date(START + 288 * 2 * 300_000)}`
      )[0]?.n ?? 0;
    const before = await total5m();
    expect(before).toBeGreaterThan(10);

    await sql`delete from engine_snapshots`; // nothing at or before the repaired point
    const small = await rig(undefined, 100); // cold start replays only the newest 100 bars per timeframe
    small.bus.publish('candle.backfilled', {
      instrumentId: instrument.id,
      canonical: instrument.canonical,
      fromMs: START,
      toMs: START + 900_000,
    });
    await small.runner.idle();
    expect(small.runner.failing.size).toBe(0);
    expect(await total5m()).toBe(before); // older history untouched
    await small.runner.stop();
  });

  it('keeps a bounded set of snapshots: the last 12 hourly plus one per day', async () => {
    const all = generate(instrument.canonical, 288 * 4);
    const cutoff = (h: number) => START + h * 3_600_000;
    await insert(all.filter((c) => c.openTime + TIMEFRAME_MS[c.tf] <= cutoff(48)));
    const r = await rig();
    r.notify();
    await r.runner.idle();
    for (let h = 49; h <= 72; h++) {
      await insert(
        all.filter(
          (c) =>
            c.openTime + TIMEFRAME_MS[c.tf] > cutoff(h - 1) &&
            c.openTime + TIMEFRAME_MS[c.tf] <= cutoff(h),
        ),
      );
      r.notify();
      await r.runner.idle();
    }
    const snaps = await sql<{ as_of: Date }[]>`
      select as_of from engine_snapshots where instrument_id = ${instrument.id} order by as_of`;
    const latest = START + 72 * 3_600_000;
    for (const s of snaps) {
      const t = s.as_of.getTime();
      if (t < latest - 12 * 3_600_000) expect(t % 86_400_000).toBe(0); // older ones are daily only
    }
    expect(snaps.length).toBeLessThanOrEqual(12 + 1 + 3);
    expect(snaps.length).toBeGreaterThanOrEqual(12);
    await r.runner.stop();
  }, 180_000);
});
