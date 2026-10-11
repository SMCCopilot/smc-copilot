import { type Candle, TIMEFRAME_MS, type Timeframe, TradePlanSchema } from '@smc/contracts';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import { createEngine, type EngineEvent, feed } from '@smc/smc-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EngineRunner } from '../src/engine/engine.runner.js';
import { EngineStore } from '../src/engine/engine.store.js';
import { applySetupEvents } from '../src/engine/setup.store.js';
import { CandleStore } from '../src/ingest/candle-store.js';
import { InMemoryEventBus } from '../src/ingest/event-bus.js';
import { InstrumentRegistry } from '../src/ingest/instrument-registry.js';

const START = Date.UTC(2026, 9, 12);
const TFS: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
const DAY = 86_400_000;

let server: TestServer;
let sql: Sql;
let candles: CandleStore;
let instrument: { id: string; canonical: string; tick: number };
let strategyId = '';

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

/** A trending-and-reverting walk (regime changes every ~half day) so structure and setups actually form. */
function generate(canonical: string, bars5m: number, seed: number): Candle[] {
  const rnd = mulberry32(seed);
  const base: Candle[] = [];
  let price = 60_000;
  let drift = 0;
  for (let i = 0; i < bars5m; i++) {
    if (i % 150 === 0) drift = Math.floor((rnd() - 0.5) * 40);
    const o = price;
    const c = Math.max(1000, o + drift + Math.floor((rnd() - 0.5) * 120));
    price = c;
    base.push({
      instrumentId: canonical,
      tf: '5m',
      openTime: START + i * 300_000,
      o,
      h: Math.max(o, c) + Math.floor(rnd() * 45),
      l: Math.max(1, Math.min(o, c) - Math.floor(rnd() * 45)),
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
    for (let t = START; ; t += ms) {
      const i = (t - START) / 300_000;
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

async function pure(): Promise<EngineEvent[]> {
  const strategy = await new EngineStore(sql).activeStrategy();
  const all: Candle[] = [];
  for (const tf of TFS) {
    for (const r of await candles.closedAfter(instrument.id, tf, undefined, 100_000)) {
      all.push({ ...r, instrumentId: instrument.canonical, closed: true });
    }
  }
  return feed(createEngine(instrument.canonical), all, strategy?.config as never, {
    tickSize: instrument.tick,
  }).events;
}

beforeAll(async () => {
  server = await startTestServer();
  sql = createClient(await server.createDatabase(), { max: 5 });
  await applyMigrations(sql, { withShims: true });
  candles = new CandleStore(sql);
  const registry = await InstrumentRegistry.load(sql);
  const i = registry.forVenueSymbol('binance', 'PERP', 'BTCUSDT');
  if (!i) throw new Error('seed instrument missing');
  const [t] = await sql<
    { tick_size: string }[]
  >`select tick_size from instruments where id = ${i.id}`;
  instrument = { id: i.id, canonical: i.canonical, tick: Number(t?.tick_size) };
  strategyId = (await new EngineStore(sql).activeStrategy())?.id ?? '';
  await candles.ensurePartitions(START - DAY, START + 30 * DAY);
}, 180_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await server.stop();
});

beforeEach(async () => {
  await sql`truncate engine_events, engine_snapshots, setups cascade`;
  await sql`delete from cohort_stats`;
  await sql`delete from candles where instrument_id = ${instrument.id}`;
});

const noop = { warn: () => {}, info: () => {} };
async function run(): Promise<EngineRunner> {
  const bus = new InMemoryEventBus();
  const runner = new EngineRunner(sql, bus, candles, noop, { now: () => Number.MAX_SAFE_INTEGER });
  await runner.start();
  bus.publish('candle.closed', {
    instrumentId: instrument.id,
    canonical: instrument.canonical,
    tf: '5m',
    openTime: START,
    status: 'CLOSED',
    source: 'live',
  });
  await runner.idle();
  return runner;
}

/** What the setup tables should say, derived from the event stream alone. */
function project(events: EngineEvent[]) {
  const bySetup = new Map<string, EngineEvent[]>();
  for (const e of events) {
    const k = e.data.setupKey;
    if (typeof k === 'string') bySetup.set(k, [...(bySetup.get(k) ?? []), e]);
  }
  const out = new Map<string, { state: string; transitions: number; outcome: string | null }>();
  for (const [k, evs] of bySetup) {
    let state = 'CANDIDATE';
    let transitions = 0;
    let outcome: string | null = null;
    for (const e of evs) {
      if (e.type === 'SETUP_CANDIDATE') transitions++;
      else if (e.type === 'SETUP_REJECTED') {
        state = 'REJECTED';
        transitions++;
      } else if (e.type === 'SETUP_ARMED') {
        state = 'ARMED';
        transitions++;
      } else if (e.type === 'SETUP_TRIGGERED') {
        state = 'TRIGGERED';
        transitions++;
      } else if (e.type === 'SETUP_EXPIRED') {
        state = 'EXPIRED';
        transitions++;
      } else if (e.type === 'SETUP_INVALIDATED') {
        state = 'INVALIDATED';
        transitions++;
      } else if (e.type === 'SETUP_RESOLVED') {
        outcome = String(e.data.outcome);
        if (outcome === 'TP1_FIRST' || outcome === 'SL_FIRST') {
          state = 'RESOLVED';
          transitions++;
        }
      }
    }
    out.set(k, { state, transitions, outcome });
  }
  return out;
}

const SEED = 21;

describe('setups are persisted exactly as the pure engine produced them', () => {
  it('projects candidates, plans, transitions and outcomes into the tables', async () => {
    await insert(generate(instrument.canonical, 288 * 8, SEED));
    const events = await pure();
    const expected = project(events);
    // The data must actually exercise the lifecycle, or this test proves nothing.
    expect([...expected.values()].filter((s) => s.state !== 'REJECTED').length).toBeGreaterThan(2);
    expect([...expected.values()].some((s) => s.outcome !== null)).toBe(true);

    await run();
    const rows = await sql<{ setup_key: string; state: string; n: number }[]>`
      select s.setup_key, s.state, (select count(*)::int from setup_transitions t where t.setup_id = s.id) as n
        from setups s where s.strategy_version_id = ${strategyId}`;
    expect(rows.length).toBe(expected.size);
    for (const r of rows) {
      const want = expected.get(r.setup_key);
      expect({ state: r.state, transitions: r.n }).toEqual({
        state: want?.state,
        transitions: want?.transitions,
      });
    }

    const planCount = events.filter((e) => e.type === 'PLAN_READY').length;
    const plans = await sql<{ plan: unknown }[]>`select plan from trade_plans`;
    expect(plans.length).toBe(planCount);
    for (const p of plans) {
      const plan = TradePlanSchema.parse(p.plan);
      expect(plan.stats).toBeNull();
      expect(plan.statsReason).toBe('INSUFFICIENT_HISTORY');
      expect(plan.confidence).toBe('LOW');
    }

    const resolved = events.filter((e) => e.type === 'SETUP_RESOLVED');
    const outcomes = await sql<{ outcome: string }[]>`select outcome from setup_outcomes`;
    expect(outcomes.length).toBe(resolved.length);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(
      resolved.map((e) => String(e.data.outcome)).sort(),
    );
  }, 300_000);

  it('a restart replays stored events without duplicating transitions, plans or outcomes', async () => {
    await insert(generate(instrument.canonical, 288 * 6, SEED));
    const first = await run();
    await first.stop();
    const snapshot = async () =>
      JSON.stringify({
        setups: await sql`select setup_key, state, grade, score from setups order by setup_key`,
        transitions: await sql`select count(*)::int as n from setup_transitions`,
        plans: await sql`select count(*)::int as n from trade_plans`,
        outcomes: await sql`select count(*)::int as n from setup_outcomes`,
      });
    const before = await snapshot();
    expect(JSON.parse(before).transitions[0].n).toBeGreaterThan(3);
    await sql`delete from engine_snapshots`; // force a full re-derivation from the candles
    const second = await run();
    await second.stop();
    expect(await snapshot()).toBe(before);
  }, 300_000);
});

describe('base rates attach to plans only when the cohort is sufficient', () => {
  const plan = {
    planId: 'Ptest',
    setupId: 'Stest',
    strategyVersionId: 'v',
    direction: 'LONG',
    entry: { type: 'LIMIT_ZONE', top: 110, bottom: 100, refPrice: 105, refBasis: 'OB_50' },
    stop: { price: 95, basis: 'SWEEP_EXTREME', bufferAtr: 0.1 },
    targets: [{ id: 'TP1', price: 130, levelId: 'L1', rr: 2.5, label: 'TP1' }],
    scenarios: {
      primary: {
        kind: 'REVERSAL',
        condition: { type: 'CLOSE_ABOVE', level: 110, levelId: 'Z1' },
        next: null,
      },
      alternate: {
        kind: 'SWEEP_NOT_REVERSAL',
        condition: { type: 'CLOSE_BELOW', level: 100, levelId: 'Z1' },
        next: null,
      },
    },
    invalidation: { level: 99, rule: 'CLOSE_BELOW_LEVEL_VOIDS_THESIS' },
    assumptions: { spread: 1, slippage: 0.1, feeBps: 5, fillModel: 'TOUCH_PLUS_TICK' },
    stats: null,
    statsReason: 'INSUFFICIENT_HISTORY',
    confidence: 'LOW',
    disclaimers: ['NOT_ADVICE'],
  };
  const ev = (
    type: EngineEvent['type'],
    data: Record<string, unknown>,
    time: number,
  ): EngineEvent => ({
    id: `${type}-${time}`,
    type,
    tf: '15m',
    scale: null,
    time,
    anchorOpenTime: time - 900_000,
    data: data as never,
  });
  const store = async (key: string) => {
    const t = START + 1000;
    await sql.begin(async (tx) => {
      await applySetupEvents(tx as unknown as Sql, instrument.id, strategyId, [
        ev(
          'SETUP_CANDIDATE',
          {
            setupKey: key,
            template: 'T1',
            direction: 'LONG',
            entryTf: '15m',
            biasTf: '1d',
            components: [],
            poi: null,
            invalidation: null,
          },
          t,
        ),
        ev(
          'SETUP_ARMED',
          { setupKey: key, grade: 'A', score: 80, features: {}, reasonCodes: [] },
          t,
        ),
        ev('PLAN_READY', { setupKey: key, planHash: 'h', plan }, t),
      ]);
    });
    const [r] = await sql<
      {
        plan: {
          stats: { n: number; rate: number; source: string } | null;
          statsReason: string | null;
          confidence: string;
        };
      }[]
    >`
      select p.plan from trade_plans p join setups s on s.id = p.setup_id where s.setup_key = ${key}`;
    return r?.plan;
  };
  const cohort = (over: Record<string, unknown> = {}) => {
    const row = {
      strategy_version_id: strategyId,
      asset_class: 'CRYPTO',
      template: 'T1',
      grade: 'A',
      direction: null,
      segment: 'ALL',
      source: 'LIVE_SHADOW',
      window_from: new Date('2026-01-01'),
      window_to: new Date('2026-02-01'),
      n: 40,
      wins: 16,
      rate: 0.4,
      ci_low: 0.2635,
      ci_high: 0.5541,
      sufficient: true,
      status: 'ACTIVE',
      ...over,
    };
    return sql`insert into cohort_stats ${sql(row)}`;
  };

  it('no cohort: no probability and the reason INSUFFICIENT_HISTORY', async () => {
    const p = await store('k-none');
    expect(p).toMatchObject({
      stats: null,
      statsReason: 'INSUFFICIENT_HISTORY',
      confidence: 'LOW',
    });
  });

  it('n = 40 with 16 wins attaches rate 0.4 with the CI, marked as history not a forecast', async () => {
    await cohort();
    const p = await store('k-40');
    expect(p?.stats).toMatchObject({
      n: 40,
      rate: 0.4,
      source: 'LIVE_SHADOW',
      disclaimerKey: 'HISTORICAL_NOT_FORECAST',
    });
    expect(p?.statsReason).toBeNull();
    expect(p?.confidence).toBe('MEDIUM'); // CI wider than 0.15
  });

  it('n = 29 attaches nothing even though a row exists', async () => {
    await cohort({ n: 29, wins: 20, sufficient: false });
    expect((await store('k-29'))?.stats).toBeNull();
  });

  it('a cohort UNDER_REVIEW shows nothing until reviewed', async () => {
    await cohort({ status: 'UNDER_REVIEW' });
    expect((await store('k-review'))?.stats).toBeNull();
  });

  it('prefers live shadow over a backtest of the same cohort', async () => {
    await cohort({ source: 'BACKTEST', n: 200, wins: 90, rate: 0.45 });
    await cohort({ source: 'LIVE_SHADOW' });
    expect((await store('k-both'))?.stats?.source).toBe('LIVE_SHADOW');
  });
});

describe('rebuild after a data repair', () => {
  it('flags revised setups, never rewrites a resolved one, and closes setups whose candidate vanished', async () => {
    await insert(generate(instrument.canonical, 288 * 6, SEED));
    const runner = await run();
    const resolvedBefore = await sql<{ setup_key: string; state: string }[]>`
      select setup_key, state from setups where state = 'RESOLVED' order by setup_key`;

    const target = START + 3 * DAY + 3_600_000;
    await sql`
      update candles set h = h + 1500, l = greatest(l - 1500, 1)
       where instrument_id = ${instrument.id} and tf = '15m' and open_time = ${new Date(target)}`;
    const bus = new InMemoryEventBus();
    const rebuilder = new EngineRunner(sql, bus, candles, noop, {
      now: () => Number.MAX_SAFE_INTEGER,
    });
    await runner.stop();
    await rebuilder.start();
    bus.publish('candle.backfilled', {
      instrumentId: instrument.id,
      canonical: instrument.canonical,
      fromMs: target,
      toMs: target + 900_000,
    });
    await rebuilder.idle();
    expect(rebuilder.failing.size).toBe(0);

    // Resolved setups from before the repair keep their state.
    const kept = await sql<{ setup_key: string; state: string }[]>`
      select setup_key, state from setups where setup_key = any(${resolvedBefore.map((r) => r.setup_key)}::text[]) order by setup_key`;
    expect(kept).toEqual(resolvedBefore);

    // Every setup whose candidate event was retracted is flagged, and is no longer live.
    const orphaned = await sql<{ setup_key: string; state: string; data_revised: boolean }[]>`
      select s.setup_key, s.state, s.data_revised from setups s
       where exists (select 1 from engine_events e
                      where e.type = 'SETUP_CANDIDATE' and e.retracted and e.payload #>> '{data,setupKey}' = s.setup_key)`;
    for (const s of orphaned) {
      expect(s.data_revised).toBe(true);
      expect(['CANDIDATE', 'ARMED', 'TRIGGERED']).not.toContain(s.state);
    }
    // And the stored events equal a fresh pure replay of the repaired candles.
    const stored = await sql<
      { event_id: string }[]
    >`select event_id from engine_events where not retracted order by event_id`;
    expect(stored.map((r) => r.event_id)).toEqual((await pure()).map((e) => e.id).sort());
    await rebuilder.stop();
  }, 300_000);
});

describe('cohort statistics and calibration jobs', () => {
  const insertSetup = async (
    i: number,
    over: {
      grade?: string;
      direction?: string;
      outcome: string;
      filled?: boolean;
      r?: number | null;
    },
  ) => {
    const [s] = await sql<{ id: string }[]>`
      insert into setups (setup_key, strategy_version_id, instrument_id, template, direction, entry_tf, bias_tf, state,
                          grade, score, components, poi, invalidation, created_at)
      values (${`job-${i}`}, ${strategyId}, ${instrument.id}, 'T1', ${over.direction ?? 'LONG'}, '15m', '1d', 'RESOLVED',
              ${over.grade ?? 'A'}, 80, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, ${new Date(START + i * 900_000)})
      returning id`;
    await sql`
      insert into setup_outcomes (setup_id, outcome_rules_version, outcome, filled, resolution_time, realized_r, mfe_r, mae_r, bars_to_resolution, ambiguous_intrabar)
      values (${s?.id as string}, 'shadow-v1', ${over.outcome}, ${over.filled ?? true}, ${new Date(START + i * 900_000 + 3_600_000)},
              ${over.r === undefined ? 1 : over.r}, 1.5, 0.3, 4, false)`;
    return s?.id as string;
  };
  const seed = async () => {
    let i = 0;
    for (let k = 0; k < 16; k++) await insertSetup(i++, { outcome: 'TP1_FIRST', r: 2.3 });
    for (let k = 0; k < 24; k++) await insertSetup(i++, { outcome: 'SL_FIRST', r: -1.1 });
    for (let k = 0; k < 5; k++)
      await insertSetup(i++, { outcome: 'NO_FILL', filled: false, r: null });
    return i;
  };
  beforeEach(async () => {
    await sql`delete from calibration_reports`;
  });

  it('writes the cohort: 16 of 40 resolved gives 0.400 with its interval; no-fills are not in the rate', async () => {
    await seed();
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    expect(await jobs.refreshCohorts(strategyId)).toBeGreaterThan(0);
    const [c] = await sql<
      {
        n: number;
        wins: number;
        rate: string;
        ci_low: string;
        ci_high: string;
        sufficient: boolean;
        avg_r: string;
      }[]
    >`
      select n, wins, rate, ci_low, ci_high, sufficient, avg_r from cohort_stats
       where strategy_version_id = ${strategyId} and template = 'T1' and grade = 'A' and direction is null and source = 'LIVE_SHADOW'`;
    expect(c).toMatchObject({ n: 40, wins: 16, sufficient: true });
    expect(Number(c?.rate)).toBeCloseTo(0.4, 5);
    expect(Number(c?.ci_low)).toBeCloseTo(0.2635, 3);
    expect(Number(c?.ci_high)).toBeCloseTo(0.5541, 3);
    expect(Number(c?.avg_r)).toBeCloseTo((16 * 2.3 + 24 * -1.1) / 40, 3);
  });

  it('is idempotent: running it again updates the row instead of adding another', async () => {
    await seed();
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    await jobs.refreshCohorts(strategyId);
    const count = async () =>
      (await sql<{ n: number }[]>`select count(*)::int as n from cohort_stats`)[0]?.n;
    const first = await count();
    await jobs.refreshCohorts(strategyId);
    expect(await count()).toBe(first);
  });

  it('leaves out outcomes flagged data_revised', async () => {
    await seed();
    await sql`update setup_outcomes set data_revised = true
               where setup_id in (select id from setups where setup_key in ('job-0','job-1','job-2'))`;
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    await jobs.refreshCohorts(strategyId);
    const [c] = await sql<{ n: number }[]>`
      select n from cohort_stats where template = 'T1' and grade = 'A' and direction is null and source = 'LIVE_SHADOW'`;
    expect(c?.n).toBe(37);
  });

  it('holds a cohort UNDER_REVIEW when the live rate drifts outside its backtest interval, and keeps it there', async () => {
    await seed();
    await sql`insert into cohort_stats (strategy_version_id, asset_class, template, grade, direction, segment, source, window_from, window_to, n, wins, rate, ci_low, ci_high, sufficient)
              values (${strategyId}, 'CRYPTO', 'T1', 'A', null, 'ALL', 'BACKTEST', now(), now(), 200, 130, 0.65, 0.58, 0.72, true)`;
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    await jobs.refreshCohorts(strategyId);
    const status = async () =>
      (
        await sql<{ status: string }[]>`
      select status from cohort_stats where template = 'T1' and grade = 'A' and direction is null and source = 'LIVE_SHADOW'`
      )[0]?.status;
    expect(await status()).toBe('UNDER_REVIEW');
    await sql`delete from setups where setup_key like 'job-%' and (select outcome from setup_outcomes where setup_id = setups.id) = 'SL_FIRST'`;
    await jobs.refreshCohorts(strategyId); // the rate now looks fine, but a human has to release it
    expect(await status()).toBe('UNDER_REVIEW');
    // Under review means no probability reaches a plan.
    expect((await new EngineStore(sql).activeStrategy())?.id).toBe(strategyId);
  });

  it('calibration: displayed rates vs resolved outcomes (Brier, reliability bins)', async () => {
    const ids: string[] = [];
    let i = 0;
    for (let k = 0; k < 10; k++)
      ids.push(await insertSetup(i++, { outcome: k < 4 ? 'TP1_FIRST' : 'SL_FIRST' }));
    ids.push(await insertSetup(i++, { outcome: 'NO_FILL', filled: false, r: null }));
    await sql`insert into cohort_stats (strategy_version_id, asset_class, template, grade, direction, segment, source, window_from, window_to, n, wins, rate, ci_low, ci_high, sufficient)
              values (${strategyId}, 'CRYPTO', 'T1', 'A', null, 'ALL', 'LIVE_SHADOW', now(), now(), 40, 16, 0.4, 0.26, 0.55, true)`;
    const [coh] = await sql<
      { id: string }[]
    >`select id from cohort_stats where source = 'LIVE_SHADOW' limit 1`;
    for (const id of ids) {
      await sql`insert into setup_displays (setup_id, cohort_id, rate, ci_low, ci_high) values (${id}, ${coh?.id as string}, 0.4, 0.26, 0.55)`;
    }
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    const report = await jobs.calibrate(strategyId);
    expect(report?.n).toBe(10); // the no-fill is not a resolved outcome
    expect(report?.bins[4]).toMatchObject({ n: 10, observed: 0.4 });
    expect(report?.brier).toBeCloseTo(0.24, 10);
    const [stored] = await sql<
      { n: number }[]
    >`select count(*)::int as n from calibration_reports where strategy_version_id = ${strategyId}`;
    expect(stored?.n).toBe(1);
  });

  it('calibration with nothing displayed yet is simply empty, not an error', async () => {
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    expect(await jobs.calibrate(strategyId)).toBeNull();
  });
});

describe('review fixes: cohort lookup, stale outcomes, jobs', () => {
  const tpl = {
    planId: 'Pr',
    setupId: 'Sr',
    strategyVersionId: 'v',
    direction: 'LONG',
    entry: { type: 'LIMIT_ZONE', top: 110, bottom: 100, refPrice: 105, refBasis: 'OB_50' },
    stop: { price: 95, basis: 'SWEEP_EXTREME', bufferAtr: 0.1 },
    targets: [{ id: 'TP1', price: 130, levelId: 'L1', rr: 2.5, label: 'TP1' }],
    scenarios: {
      primary: {
        kind: 'REVERSAL',
        condition: { type: 'CLOSE_ABOVE', level: 110, levelId: 'Z1' },
        next: null,
      },
      alternate: {
        kind: 'SWEEP_NOT_REVERSAL',
        condition: { type: 'CLOSE_BELOW', level: 100, levelId: 'Z1' },
        next: null,
      },
    },
    invalidation: { level: 99, rule: 'X' },
    assumptions: { spread: 1, slippage: 0.1, feeBps: 5, fillModel: 'TOUCH_PLUS_TICK' },
    stats: null,
    statsReason: 'INSUFFICIENT_HISTORY',
    confidence: 'LOW',
    disclaimers: [],
  };
  const e = (
    type: EngineEvent['type'],
    data: Record<string, unknown>,
    time: number,
  ): EngineEvent => ({
    id: `${type}-${time}-${String(data.setupKey)}`,
    type,
    tf: '15m',
    scale: null,
    time,
    anchorOpenTime: time - 900_000,
    data: data as never,
  });
  const cohortRow = (over: Record<string, unknown>) =>
    sql`insert into cohort_stats ${sql({
      strategy_version_id: strategyId,
      asset_class: 'CRYPTO',
      template: 'T1',
      grade: 'A',
      direction: null,
      segment: 'ALL',
      source: 'LIVE_SHADOW',
      window_from: new Date('2026-01-01'),
      window_to: new Date('2026-02-01'),
      n: 40,
      wins: 16,
      rate: 0.4,
      ci_low: 0.26,
      ci_high: 0.55,
      sufficient: true,
      status: 'ACTIVE',
      ...over,
    })}`;
  const plan = async (key: string) => {
    const t = START + 5000;
    await sql.begin(async (tx) => {
      await applySetupEvents(tx as unknown as Sql, instrument.id, strategyId, [
        e(
          'SETUP_CANDIDATE',
          {
            setupKey: key,
            template: 'T1',
            direction: 'LONG',
            entryTf: '15m',
            biasTf: '1d',
            components: [],
            poi: null,
            invalidation: null,
          },
          t,
        ),
        e(
          'SETUP_ARMED',
          { setupKey: key, grade: 'A', score: 80, features: {}, reasonCodes: [] },
          t,
        ),
        e('PLAN_READY', { setupKey: key, planHash: 'h', plan: tpl }, t),
      ]);
    });
    const [r] = await sql<{ plan: { stats: unknown } }[]>`
      select p.plan from trade_plans p join setups s on s.id = p.setup_id where s.setup_key = ${key}`;
    return r?.plan;
  };

  it('a live cohort UNDER_REVIEW shows nothing and does NOT fall back to an ACTIVE backtest cohort', async () => {
    await cohortRow({ source: 'LIVE_SHADOW', status: 'UNDER_REVIEW' });
    await cohortRow({
      source: 'BACKTEST',
      n: 300,
      wins: 150,
      rate: 0.5,
      ci_low: 0.44,
      ci_high: 0.56,
    });
    expect((await plan('rv-1'))?.stats).toBeNull();
  });

  it('a resolution applied twice (after a rebuild moved the bar) writes one RESOLVED transition', async () => {
    const key = 'rv-twice';
    const t = START + 9000;
    const apply = (events: EngineEvent[]) =>
      sql.begin(async (tx) => {
        await applySetupEvents(tx as unknown as Sql, instrument.id, strategyId, events);
      });
    await apply([
      e(
        'SETUP_CANDIDATE',
        {
          setupKey: key,
          template: 'T1',
          direction: 'LONG',
          entryTf: '15m',
          biasTf: '1d',
          components: [],
          poi: null,
          invalidation: null,
        },
        t,
      ),
      e('SETUP_ARMED', { setupKey: key, grade: 'A', score: 80, features: {}, reasonCodes: [] }, t),
    ]);
    const resolved = (time: number) =>
      e(
        'SETUP_RESOLVED',
        {
          setupKey: key,
          outcome: 'SL_FIRST',
          filled: true,
          rulesVersion: 'shadow-v1',
          resolutionTime: time,
          realizedR: -1.1,
        },
        time,
      );
    await apply([resolved(t + 900_000)]);
    await apply([resolved(t + 1_800_000)]); // same setup resolving again on a later bar
    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from setup_transitions tr join setups s on s.id = tr.setup_id
       where s.setup_key = ${key} and tr.to_state = 'RESOLVED'`;
    expect(n?.n).toBe(1);
  });

  it('calibration counts each setup once (its latest display) and skips revised outcomes', async () => {
    const mkSetup = async (k: string, outcome: string, revised = false) => {
      const [s] = await sql<{ id: string }[]>`
        insert into setups (setup_key, strategy_version_id, instrument_id, template, direction, entry_tf, bias_tf, state, grade, score, components, poi, invalidation, created_at)
        values (${k}, ${strategyId}, ${instrument.id}, 'T1', 'LONG', '15m', '1d', 'RESOLVED', 'A', 80, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now()) returning id`;
      await sql`insert into setup_outcomes (setup_id, outcome_rules_version, outcome, filled, data_revised) values (${s?.id as string}, 'shadow-v1', ${outcome}, true, ${revised})`;
      return s?.id as string;
    };
    await cohortRow({ source: 'LIVE_SHADOW' });
    await cohortRow({ source: 'BACKTEST', n: 100, wins: 50, rate: 0.5, ci_low: 0.4, ci_high: 0.6 });
    const cohorts = await sql<{ id: string }[]>`select id from cohort_stats`;
    const a = await mkSetup('cal-a', 'TP1_FIRST');
    const b = await mkSetup('cal-b', 'SL_FIRST');
    const c = await mkSetup('cal-c', 'TP1_FIRST', true);
    for (const id of [a, b, c]) {
      for (const co of cohorts) {
        await sql`insert into setup_displays (setup_id, cohort_id, rate, ci_low, ci_high) values (${id}, ${co.id}, 0.4, 0.2, 0.6)`;
      }
    }
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    const report = await jobs.calibrate(strategyId);
    expect(report?.n).toBe(2); // a and b once each; c is revised; the second display per setup is not double counted
  });

  it('a cohort whose every outcome was revised away stops claiming to be sufficient', async () => {
    await cohortRow({ source: 'LIVE_SHADOW' });
    const jobs = new (await import('../src/engine/analytics.jobs.js')).AnalyticsJobs(sql);
    expect(await jobs.refreshCohorts(strategyId)).toBe(0); // no outcome rows exist
    const [c] = await sql<
      { n: number; sufficient: boolean }[]
    >`select n, sufficient from cohort_stats where source = 'LIVE_SHADOW'`;
    expect(c).toMatchObject({ n: 0, sufficient: false });
  });
});
