import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  biasAt,
  createEngine,
  dealingRange,
  type EngineState,
  feed,
  htfAt,
  premiumDiscount,
  sessionContext,
  step,
} from '../src/index.js';
import { isWeekend, monthStartOf } from '../src/sessions.js';
import { genCandles, shuffle } from './gen.js';
import { candle, config, INSTRUMENT, run } from './helpers.js';
import { WORKED_BASE_OPEN_MS, WORKED_ROWS } from './worked-example.js';

const T0 = WORKED_BASE_OPEN_MS;
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

const workedCfg = () =>
  config((c) => {
    (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
    (c.atr as { fixed?: number }).fixed = 100;
  });

function stateAfter(bars: number): EngineState {
  const cfg = workedCfg();
  let state = createEngine(INSTRUMENT);
  WORKED_ROWS.slice(0, bars).forEach((row, i) => {
    state = step(state, candle('15m', T0 + i * 900_000, row), cfg).state;
  });
  return state;
}

describe('dealing range and premium/discount (worked example)', () => {
  const state = stateAfter(20); // through idx 19 (08:00 close)
  const range = dealingRange(state.perTf['15m']?.internal as never, workedCfg());

  it('uses the CHoCH leg 63960 -> 64400 with equilibrium 64180', () => {
    expect(range).toMatchObject({ trend: 'BULL', low: 63960, high: 64400, eq: 64180 });
  });

  it('puts the OTE band at [64052.4, 64127.2]', () => {
    expect(range?.ote.bottom).toBeCloseTo(64052.4, 6);
    expect(range?.ote.top).toBeCloseTo(64127.2, 6);
  });

  it('places the 64075 entry in discount at 0.26 of the range', () => {
    const pd = premiumDiscount(64075, range as never);
    expect(pd.zone).toBe('DISCOUNT');
    expect(pd.pct).toBeCloseTo(0.2614, 3);
    expect(premiumDiscount(64300, range as never).zone).toBe('PREMIUM');
    expect(premiumDiscount(64180, range as never).zone).toBe('EQ');
    expect(premiumDiscount(70000, range as never).pct).toBe(1);
  });

  it('has no range before a trend exists', () => {
    expect(dealingRange(stateAfter(5).perTf['15m']?.internal as never, workedCfg())).toBeNull();
  });
});

describe('UTC calendar and sessions', () => {
  it('monthStartOf matches Date.UTC for any timestamp', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (t) => {
        const d = new Date(t);
        expect(monthStartOf(t)).toBe(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      }),
      { numRuns: 2000 },
    );
  });

  it('isWeekend matches the UTC weekday', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (t) => {
        const dow = new Date(t).getUTCDay();
        expect(isWeekend(t)).toBe(dow === 0 || dow === 6);
      }),
      { numRuns: 1000 },
    );
  });

  it('reports London killzone and overlapping Asia at 07:45 UTC', () => {
    const ctx = sessionContext(Date.UTC(2026, 9, 12, 7, 45), config());
    expect(ctx).toMatchObject({
      active: ['ASIA', 'LONDON'],
      killzones: ['LONDON'],
      inKillzone: true,
    });
    expect(ctx.minutesSinceOpen).toEqual({ ASIA: 465, LONDON: 45 });
    expect(ctx.weekend).toBe(false);
  });

  it('is outside every killzone at 11:00 and on a Saturday', () => {
    expect(sessionContext(Date.UTC(2026, 9, 12, 11), config()).inKillzone).toBe(false);
    expect(sessionContext(Date.UTC(2026, 9, 17, 13), config())).toMatchObject({
      weekend: true,
      inKillzone: true,
    });
  });

  it('turns the Asia high/low into pools when the session ends at 08:00 (closes 08:15)', () => {
    const ev = run(WORKED_ROWS, workedCfg(), { start: T0 }).filter(
      (e) => e.type === 'POOL_NEW' && (e.data.kind === 'SESH' || e.data.kind === 'SESL'),
    );
    expect(ev.map((e) => [e.data.kind, e.data.level, hhmm(e.time)])).toEqual([
      ['SESH', 64450, '08:15'],
      ['SESL', 63960, '08:15'],
    ]);
  });

  it('refuses non-UTC sessions instead of silently treating them as UTC', () => {
    expect(() =>
      config((c) => {
        for (const s of c.sessions as { tz: string }[]) s.tz = 'America/New_York';
      }),
    ).toThrow(/UTC/);
  });
});

describe('multi-timeframe model', () => {
  const data = genCandles(INSTRUMENT, 7, 288 * 12);
  const cfg = config();

  it('processes the same output whatever order candles arrive in', () => {
    const base = feed(createEngine(INSTRUMENT), data, cfg);
    for (const seed of [1, 2, 3]) {
      const shuffled = feed(createEngine(INSTRUMENT), shuffle(data, seed), cfg);
      expect(JSON.stringify(shuffled.events)).toBe(JSON.stringify(base.events));
      expect(JSON.stringify(shuffled.state)).toBe(JSON.stringify(base.state));
    }
  }, 120_000);

  it('never exposes an HTF snapshot newer than the query time', () => {
    const { state } = feed(createEngine(INSTRUMENT), data, cfg);
    const snaps = state.mtf['4h'] ?? [];
    expect(snaps.length).toBeGreaterThan(3);
    for (const s of snaps) {
      expect(htfAt(state, '4h', s.closeTime - 1)?.closeTime ?? 0).toBeLessThan(s.closeTime);
      expect(htfAt(state, '4h', s.closeTime)?.closeTime).toBe(s.closeTime);
    }
    expect(htfAt(state, '4h', (snaps[0]?.closeTime ?? 1) - 1)).toBeNull();
  });

  it('resolves bias from the bias timeframes only: all bull, all bear, else RANGE', () => {
    const snap = (trend: 'BULL' | 'BEAR' | 'UNDEFINED') => [
      {
        closeTime: 1,
        trend,
        protectedLevel: null,
        rangeLow: null,
        rangeHigh: null,
        lastBreakId: null,
        lastBreakType: null,
      },
    ];
    const mk = (
      d: 'BULL' | 'BEAR' | 'UNDEFINED',
      h4: 'BULL' | 'BEAR' | 'UNDEFINED',
    ): EngineState => ({
      ...createEngine(INSTRUMENT),
      mtf: { '1d': snap(d), '4h': snap(h4) },
    });
    expect(biasAt(mk('BULL', 'BULL'), cfg, 5).trend).toBe('BULL');
    expect(biasAt(mk('BEAR', 'BEAR'), cfg, 5).trend).toBe('BEAR');
    expect(biasAt(mk('BULL', 'BEAR'), cfg, 5).trend).toBe('RANGE');
    expect(biasAt(mk('BULL', 'UNDEFINED'), cfg, 5).trend).toBe('RANGE');
    expect(biasAt(createEngine(INSTRUMENT), cfg, 5).trend).toBe('RANGE');
    expect(biasAt(mk('BULL', 'BULL'), cfg, 0).trend).toBe('RANGE'); // snapshots not yet closed at t=0
  });
});
