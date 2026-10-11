import { MarketFactsSchema } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import { buildFacts, createEngine, type EngineEvent, feed, sha1, step } from '../src/index.js';
import { genCandles } from './gen.js';
import { config, INSTRUMENT, run } from './helpers.js';
import { WORKED_BASE_OPEN_MS, WORKED_ROWS } from './worked-example.js';

declare const performance: { now(): number };

const cfg = config();
const data = genCandles(INSTRUMENT, 11, 288 * 20);

/** Stable digest of an event stream: ids, types, times and payloads in emission order. */
export const streamHash = (events: readonly EngineEvent[]): string =>
  sha1(events.map((e) => JSON.stringify([e.id, e.type, e.tf, e.scale, e.time, e.data])).join('\n'));
export const countsOf = (events: readonly EngineEvent[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of events) out[e.type] = (out[e.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

describe('ChartFacts', () => {
  const { state } = feed(createEngine(INSTRUMENT), data, cfg);
  const asOf = Math.max(...Object.values(state.lastCandleOpenTime)) + 86_400_000;
  const facts = buildFacts(state, cfg, { asOf, dataQuality: 'OK' });

  it('satisfies the MarketFacts contract and is deterministic', () => {
    expect(() => MarketFactsSchema.parse(facts)).not.toThrow();
    expect(buildFacts(state, cfg, { asOf, dataQuality: 'OK' })).toEqual(facts);
    expect(facts.levels.length).toBeGreaterThan(0);
    expect(facts.zones.length).toBeGreaterThan(0);
    expect(facts.setups).toEqual([]);
  });

  it('keeps prices out of labels and ids unique', () => {
    const prices = new Set([...facts.levels.map((l) => l.price), ...facts.zones.map((z) => z.top)]);
    for (const item of [...facts.levels, ...facts.zones]) {
      for (const p of prices) {
        if (Math.abs(p) >= 1000) expect(item.label).not.toContain(String(Math.round(p)));
      }
    }
    const ids = [...facts.levels, ...facts.zones].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only lists live zones (filled gaps are dropped)', () => {
    for (const z of facts.zones) expect(z.state).not.toBe('FILLED');
  });
});

describe('state: snapshot, bounds, restart', () => {
  it('a state restored from JSON continues exactly like the original', () => {
    const half = Math.floor(data.length / 2);
    const first = feed(createEngine(INSTRUMENT), data.slice(0, half), cfg);
    const restored = JSON.parse(JSON.stringify(first.state));
    const a = feed(first.state, data.slice(half), cfg);
    const b = feed(restored, data.slice(half), cfg);
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('is bounded: state size stops growing once windows are full', () => {
    const tfs = ['5m', '15m', '1h'] as const;
    const long = genCandles(INSTRUMENT, 5, 288 * 60, undefined, tfs).sort(
      (a, b) => a.openTime - b.openTime,
    );
    const at = (n: number) =>
      JSON.stringify(feed(createEngine(INSTRUMENT), long.slice(0, n), cfg).state).length;
    const mid = at(Math.floor(long.length * 0.8));
    const full = at(long.length);
    expect(full).toBeLessThan(mid * 1.12);
    expect(full).toBeLessThan(400_000);
  });

  it('re-feeding already processed candles emits nothing (idempotent replay)', () => {
    const once = feed(createEngine(INSTRUMENT), data, cfg);
    const again = feed(once.state, data, cfg);
    expect(again.events).toEqual([]);
    expect(JSON.stringify(again.state)).toBe(JSON.stringify(once.state));
  });
});

describe('golden replay', () => {
  it('worked example (golden 0) hash is pinned', () => {
    const c = config((j) => {
      (j.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
      (j.atr as { fixed?: number }).fixed = 100;
      (j.fvg as { minSizeAtrMult: number }).minSizeAtrMult = 0.25;
    });
    const ev = run(WORKED_ROWS, c, { start: WORKED_BASE_OPEN_MS });
    expect({ hash: streamHash(ev), counts: countsOf(ev) }).toMatchSnapshot();
  });

  it('synthetic multi-timeframe dataset hash is pinned (seed 11, 20 days)', () => {
    const ev = feed(createEngine(INSTRUMENT), data, cfg).events;
    expect({ hash: streamHash(ev), counts: countsOf(ev) }).toMatchSnapshot();
  });
});

describe('performance', () => {
  it('step p95 stays under 20 ms for 4 instruments x 4 timeframes', () => {
    const instruments = [
      'BINANCE:SPOT:BTCUSDT',
      'BINANCE:SPOT:ETHUSDT',
      'BINANCE:PERP:BTCUSDT',
      'BYBIT:PERP:ETHUSDT',
    ];
    const times: number[] = [];
    instruments.forEach((id, k) => {
      const candles = genCandles(id, 100 + k, 288 * 30, undefined, ['5m', '15m', '1h', '4h']);
      let state = createEngine(id);
      for (const c of candles.slice().sort((a, b) => a.openTime - b.openTime)) {
        const t0 = performance.now();
        state = step(state, c, cfg).state;
        times.push(performance.now() - t0);
      }
    });
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    const max = times[times.length - 1] as number;
    expect(times.length).toBeGreaterThan(30_000);
    expect(p95).toBeLessThan(20);
    expect(max).toBeLessThan(250);
  });
});
