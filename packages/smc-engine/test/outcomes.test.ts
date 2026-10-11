import { describe, expect, it } from 'vitest';
import { forceExpire, resolveStep } from '../src/outcomes.js';
import { collectTargets, pickTargets } from '../src/planner.js';
import { FEATURE_IDS, scoreSetup } from '../src/score.js';
import type { CandleLite, SetupRecord } from '../src/types.js';
import { config } from './helpers.js';

/**
 * LONG: POI [100, 110], ref 105, stop 95 (risk 10 + 0.1 slippage on the fill = 10.1), TP1 130, tick 0.1, fee 5 bps.
 * SHORT mirror is built by reflecting prices around 1000 (every number below flips).
 */
const longSetup = (patch: Partial<SetupRecord> = {}): SetupRecord => ({
  key: 'k',
  template: 'T2',
  direction: 'LONG',
  entryTf: '15m',
  biasTf: '1d',
  state: 'ARMED',
  grade: 'A',
  score: 80,
  createdAt: 0,
  createdIndex: 0,
  poi: { zoneId: 'z', kind: 'OB', top: 110, bottom: 100, ref: 105 },
  stop: 95,
  invalidation: 99,
  targets: [{ id: 'TP1', price: 130, levelId: 'L', rr: 2.5, label: 'TP1' }],
  slippage: 0.1,
  halfSpread: 0,
  feeBps: 5,
  touched: false,
  fill: null,
  hi: 0,
  lo: 0,
  ambiguous: false,
  planHash: 'h',
  ...patch,
});
const bar = (o: number, h: number, l: number, c: number, t = 0): CandleLite => ({ t, o, h, l, c });
const LIMITS = { expiryBars: 10, resolveBars: 10 };
const go = (s: SetupRecord, b: CandleLite, index: number, brk = false) =>
  resolveStep(s, b, index, (index + 1) * 900_000, LIMITS, brk);

/** Advance through bars, returning the final result. */
function play(s: SetupRecord, bars: CandleLite[], from = 1) {
  let cur: SetupRecord | null = s;
  let last = go(s, bars[0] as CandleLite, from);
  for (let i = 1; i < bars.length && last.setup; i++) {
    cur = last.setup;
    last = go(cur, bars[i] as CandleLite, from + i);
  }
  return last;
}

describe('shadow outcome resolver (long)', () => {
  it('no fill when price never trades down to the entry, then NO_FILL at expiry', () => {
    const bars = Array.from({ length: 12 }, () => bar(120, 125, 115, 120));
    const r = play(longSetup(), bars);
    expect(r.outcome?.outcome).toBe('NO_FILL');
    expect(r.outcome?.filled).toBe(false);
    expect(r.transitions).toEqual([{ to: 'EXPIRED', reasons: ['SETUP_EXPIRED'] }]);
    expect(r.outcome?.barsToResolution).toBe(10);
  });

  it('fills at ref plus one tick of adverse slippage, then TP1 on a later candle', () => {
    const r = play(longSetup(), [bar(120, 121, 104, 115), bar(115, 131, 114, 130)]);
    expect(r.outcome).toMatchObject({ outcome: 'TP1_FIRST', filled: true, fillPrice: 105.1 });
    // risk = 105.1 - 95 = 10.1; gross = (130 - 105.1) / 10.1; fees = 5bps x (105.1 + 130) / 10.1
    const gross = (130 - 105.1) / 10.1;
    const fees = (0.0005 * (105.1 + 130)) / 10.1;
    expect(r.outcome?.feesR).toBeCloseTo(fees, 3);
    expect(r.outcome?.realizedR).toBeCloseTo(gross - fees, 3);
    expect(r.outcome?.rTp1).toBeCloseTo(gross - fees, 3);
  });

  it('TP then SL: the target hit first on an earlier candle wins', () => {
    const r = play(longSetup(), [
      bar(120, 121, 104, 115),
      bar(115, 131, 114, 130),
      bar(130, 131, 80, 85),
    ]);
    expect(r.outcome?.outcome).toBe('TP1_FIRST');
  });

  it('SL then TP: the stop hit first on an earlier candle loses', () => {
    const r = play(longSetup(), [
      bar(120, 121, 104, 115),
      bar(115, 116, 94, 96),
      bar(96, 140, 95, 139),
    ]);
    expect(r.outcome?.outcome).toBe('SL_FIRST');
    // exit at stop 95 minus one tick of slippage = 94.9
    const risk = 10.1;
    const gross = (94.9 - 105.1) / risk;
    const fees = (0.0005 * (105.1 + 94.9)) / risk;
    expect(r.outcome?.realizedR).toBeCloseTo(gross - fees, 3);
  });

  it('one candle touching both the stop and TP1 counts as a loss and is flagged ambiguous', () => {
    const r = play(longSetup(), [bar(120, 121, 104, 115), bar(115, 135, 90, 120)]);
    expect(r.outcome).toMatchObject({ outcome: 'SL_FIRST', ambiguousIntrabar: true });
  });

  it('a gap through the stop fills at the gap price (worse than the stop), not at the stop', () => {
    const r = play(longSetup(), [bar(120, 121, 104, 115), bar(90, 92, 88, 91)]);
    expect(r.outcome?.outcome).toBe('SL_FIRST');
    // exit = open 90 minus 0.1 slippage = 89.9, not 94.9
    const gross = (89.9 - 105.1) / 10.1;
    const fees = (0.0005 * (105.1 + 89.9)) / 10.1;
    expect(r.outcome?.realizedR).toBeCloseTo(gross - fees, 3);
    expect(r.outcome?.realizedR as number).toBeLessThan(-1.5);
  });

  it('fill and TP1 on the same candle: no credit is taken, the trade is flagged ambiguous and continues', () => {
    const first = go(longSetup(), bar(120, 135, 104, 130), 1);
    expect(first.outcome).toBeNull();
    expect(first.setup?.ambiguous).toBe(true);
    expect(first.setup?.fill?.price).toBe(105.1);
  });

  it('fill and stop on the same candle is a loss', () => {
    const r = go(longSetup(), bar(120, 121, 90, 100), 1);
    expect(r.outcome?.outcome).toBe('SL_FIRST');
  });

  it('target traded before any fill ends the idea as NO_FILL (the move ran away)', () => {
    const r = go(longSetup(), bar(120, 135, 115, 130), 1);
    expect(r.outcome?.outcome).toBe('NO_FILL');
    expect(r.transitions[0]).toEqual({ to: 'EXPIRED', reasons: ['TARGET_REACHED_FIRST'] });
  });

  it('closing through the invalidation before a fill is INVALIDATED_BEFORE_FILL', () => {
    const s = longSetup({
      poi: { zoneId: 'z', kind: 'OB', top: 110, bottom: 100, ref: 90 },
      invalidation: 99,
    });
    const r = go(s, bar(100, 101, 97, 98), 1); // stays above the ref of 90, closes below invalidation 99
    expect(r.outcome?.outcome).toBe('INVALIDATED_BEFORE_FILL');
    expect(r.transitions[0]).toEqual({ to: 'INVALIDATED', reasons: ['INVALIDATION_BREACHED'] });
  });

  it('a filled trade that neither stops nor reaches TP1 ends EXPIRED_OPEN and counts no win rate', () => {
    const bars = [
      bar(120, 121, 104, 115),
      ...Array.from({ length: 12 }, () => bar(115, 120, 110, 115)),
    ];
    const r = play(longSetup(), bars);
    expect(r.outcome?.outcome).toBe('EXPIRED_OPEN');
    expect(r.outcome?.realizedR).toBeNull();
    expect(r.outcome?.filled).toBe(true);
  });

  it('records MFE and MAE in R from the fill', () => {
    const r = play(longSetup(), [
      bar(120, 121, 100, 118),
      bar(118, 125, 99, 120),
      bar(120, 131, 119, 130),
    ]);
    expect(r.outcome?.outcome).toBe('TP1_FIRST');
    expect(r.outcome?.mfeR).toBeCloseTo((131 - 105.1) / 10.1, 3);
    expect(r.outcome?.maeR).toBeCloseTo((105.1 - 99) / 10.1, 3);
  });

  it('TRIGGERED needs a touch of the POI and then a break in the setup direction', () => {
    const noTouch = go(longSetup(), bar(128, 129, 120, 125), 1, true);
    expect(noTouch.transitions).toEqual([]);
    const touched = go(longSetup(), bar(120, 121, 109, 115), 1, false);
    expect(touched.setup?.touched).toBe(true);
    expect(touched.setup?.state).toBe('ARMED');
    const trig = go(touched.setup as SetupRecord, bar(115, 118, 112, 117), 2, true);
    expect(trig.transitions).toEqual([{ to: 'TRIGGERED', reasons: [] }]);
    expect(trig.setup?.state).toBe('TRIGGERED');
  });
});

describe('shadow outcome resolver (short mirrors long exactly)', () => {
  const flip = (b: CandleLite): CandleLite => ({
    t: b.t,
    o: 1000 - b.o,
    h: 1000 - b.l,
    l: 1000 - b.h,
    c: 1000 - b.c,
  });
  const shortSetup = (): SetupRecord =>
    longSetup({
      direction: 'SHORT',
      poi: { zoneId: 'z', kind: 'OB', top: 1000 - 100, bottom: 1000 - 110, ref: 1000 - 105 },
      stop: 1000 - 95,
      invalidation: 1000 - 99,
      targets: [{ id: 'TP1', price: 1000 - 130, levelId: 'L', rr: 2.5, label: 'TP1' }],
    });
  const scenarios: [string, CandleLite[]][] = [
    ['TP1', [bar(120, 121, 104, 115), bar(115, 131, 114, 130)]],
    ['SL', [bar(120, 121, 104, 115), bar(115, 116, 94, 96)]],
    ['gap stop', [bar(120, 121, 104, 115), bar(90, 92, 88, 91)]],
    ['ambiguous', [bar(120, 121, 104, 115), bar(115, 135, 90, 120)]],
    ['no fill', Array.from({ length: 12 }, () => bar(120, 125, 115, 120))],
  ];
  it.each(scenarios)('%s', (_name, bars) => {
    // Fees are bps of price, so they differ at a different price level: compare the mirror with zero fees.
    const a = play(longSetup({ feeBps: 0 }), bars);
    const b = play({ ...shortSetup(), feeBps: 0 }, bars.map(flip));
    expect(b.outcome?.outcome).toBe(a.outcome?.outcome);
    expect(b.outcome?.realizedR).toBe(a.outcome?.realizedR);
    expect(b.outcome?.mfeR).toBe(a.outcome?.mfeR);
    expect(b.outcome?.maeR).toBe(a.outcome?.maeR);
    expect(b.outcome?.ambiguousIntrabar).toBe(a.outcome?.ambiguousIntrabar);
  });
});

describe('planner: targets are levels, never arbitrary R multiples', () => {
  const cand = (price: number, htf = false) => ({ levelId: `L${price}`, price, htf });
  it('TP1 is the nearest level giving at least minRR; TP2 prefers the next HTF level', () => {
    // ref 100, risk 10: 105 is 0.5R, 112 is 1.2R (below 1.5), 118 is 1.8R, 125 (ltf) and 140 (htf) beyond
    const p = pickTargets(
      [cand(105), cand(112), cand(118), cand(125), cand(140, true)],
      100,
      10,
      1.5,
      true,
    );
    expect(p.targets.map((t) => [t.label, t.price, t.rr])).toEqual([
      ['TP1', 118, 1.8],
      ['TP2', 140, 4],
    ]);
  });
  it('falls back to the next level of any kind for TP2, and omits TP2 when there is none', () => {
    expect(
      pickTargets([cand(118), cand(125)], 100, 10, 1.5, true).targets.map((t) => t.price),
    ).toEqual([118, 125]);
    expect(pickTargets([cand(118)], 100, 10, 1.5, true).targets.map((t) => t.price)).toEqual([118]);
  });
  it('reports a level that exists but misses minRR separately from no level at all', () => {
    expect(pickTargets([cand(105)], 100, 10, 1.5, true)).toEqual({ targets: [], anyLevel: true });
    expect(pickTargets([], 100, 10, 1.5, true)).toEqual({ targets: [], anyLevel: false });
  });
  it('mirrors for shorts', () => {
    const p = pickTargets(
      [cand(95), cand(82), cand(60, true)].sort((a, b) => b.price - a.price),
      100,
      10,
      1.5,
      false,
    );
    expect(p.targets.map((t) => t.price)).toEqual([82, 60]);
  });
  it('collectTargets ignores swept swings and lower timeframes than the entry', () => {
    const cfg = config();
    const tfState = (swings: object[], window: object[]) =>
      ({
        window,
        base: 0,
        pools: [],
        internal: { swings },
        external: { swings: [] },
      }) as never;
    const w = (h: number) => ({ t: 0, o: 1, h, l: 1, c: 1 });
    const unsweptSwing = { id: 'a', kind: 'HIGH', level: 120, barIndex: 0 };
    const sweptSwing = { id: 'b', kind: 'HIGH', level: 115, barIndex: 0 };
    const state = {
      perTf: {
        '15m': tfState([unsweptSwing, sweptSwing], [w(120), w(116), w(110)]),
        '5m': tfState([{ id: 'c', kind: 'HIGH', level: 130, barIndex: 0 }], [w(130)]),
      },
    } as never;
    const out = collectTargets(state, cfg, '15m', 100, true);
    expect(out.map((c) => c.price)).toEqual([120]); // 115 was wicked through, the 5m swing is below the entry timeframe
  });
});

describe('scoring', () => {
  const cfg = config();
  const zero = Object.fromEntries(FEATURE_IDS.map((f) => [f, 0])) as Record<
    (typeof FEATURE_IDS)[number],
    number
  >;
  it('is the weighted sum and grades by the configured cuts', () => {
    const all = Object.fromEntries(FEATURE_IDS.map((f) => [f, 1])) as typeof zero;
    // positives sum to 100; penalties (gapBreak -10, weekend -3) apply when their flag is 1
    expect(scoreSetup({ ...all, gapBreakPenalty: 0, weekendLiquidity: 0 }, cfg)).toMatchObject({
      score: 100,
      grade: 'A',
    });
    expect(
      scoreSetup({ ...zero, htfAlignment: 1, sweepPresent: 1, displacementStrength: 1 }, cfg),
    ).toMatchObject({
      score: 50,
      grade: 'B', // exactly the lower cut
    });
    expect(scoreSetup({ ...zero, htfAlignment: 1 }, cfg)).toMatchObject({ score: 20, grade: 'C' });
  });
  it('subtracts the gap and weekend penalties and never goes below 0', () => {
    expect(scoreSetup({ ...zero, gapBreakPenalty: 1, weekendLiquidity: 1 }, cfg).score).toBe(0);
    const s = scoreSetup(
      { ...zero, htfAlignment: 1, gapBreakPenalty: 1, weekendLiquidity: 1 },
      cfg,
    );
    expect(s.score).toBe(7); // 20 - 10 - 3
  });
  it('gives an OBSERVED rule zero weight (context only)', () => {
    const observed = config((c) => {
      (c.rules as Record<string, { status: string }>).killzone = { status: 'OBSERVED' };
    });
    expect(scoreSetup({ ...zero, killzone: 1 }, observed).score).toBe(0);
    expect(scoreSetup({ ...zero, killzone: 1 }, cfg).score).toBe(10);
  });
  it('is reproducible for identical inputs', () => {
    const v = { ...zero, htfAlignment: 0.4, rrQuality: 0.9615384615384616 };
    expect(scoreSetup(v, cfg)).toEqual(scoreSetup({ ...v }, cfg));
  });
});

describe('half-spread: a limit order needs price THROUGH its level (A04 13.2)', () => {
  const withHalf = (over: Partial<SetupRecord> = {}) => longSetup({ halfSpread: 1, ...over });

  it('does not fill on a mere touch of the entry, only when price trades through by half the spread', () => {
    expect(go(withHalf(), bar(120, 121, 104.5, 115), 1).setup?.fill).toBeNull(); // ref 105, needs 104 or lower
    expect(go(withHalf(), bar(120, 121, 104, 115), 1).setup?.fill?.price).toBe(105.1);
  });

  it('does not credit TP1 on a mere touch, only when price trades through by half the spread', () => {
    const filled = go(withHalf(), bar(120, 121, 100, 115), 1).setup as SetupRecord;
    expect(go(filled, bar(115, 130.5, 114, 130), 2).outcome).toBeNull(); // TP1 130 needs 131
    expect(go(filled, bar(115, 131, 114, 130), 2).outcome?.outcome).toBe('TP1_FIRST');
  });

  it('triggers the stop half a spread early and pays the half spread on the stop exit', () => {
    const filled = go(withHalf(), bar(120, 121, 100, 115), 1).setup as SetupRecord;
    const r = go(filled, bar(100, 101, 95.5, 96), 2); // stop 95, triggers at 96
    expect(r.outcome?.outcome).toBe('SL_FIRST');
    const exit = 95 - (0.1 + 1);
    const risk = 105.1 - 95;
    const fees = (0.0005 * (105.1 + exit)) / risk;
    expect(r.outcome?.realizedR).toBeCloseTo((exit - 105.1) / risk - fees, 3);
  });

  it('is never kinder than zero spread: more pessimistic or equal on every scenario', () => {
    const bars = [bar(120, 121, 104, 115), bar(115, 131, 114, 130)];
    const a = play(longSetup(), bars);
    const b = play(withHalf(), bars);
    expect(b.outcome?.outcome).toBe(a.outcome?.outcome); // same path here
    expect((b.outcome?.realizedR ?? 0) <= (a.outcome?.realizedR ?? 0) + 1e-9).toBe(true);
  });
});

describe('setups leaving the live set are always resolved', () => {
  it('force-expiry gives NO_FILL before a fill and EXPIRED_OPEN after one, never nothing', () => {
    expect(forceExpire(longSetup(), 10, 99).outcome).toMatchObject({
      outcome: 'NO_FILL',
      filled: false,
      realizedR: null,
    });
    const filled = go(longSetup(), bar(120, 121, 104, 115), 1).setup as SetupRecord;
    expect(forceExpire(filled, 10, 99).outcome).toMatchObject({
      outcome: 'EXPIRED_OPEN',
      filled: true,
      realizedR: null,
    });
  });
});

describe('target selection ignores levels already traded through', () => {
  it('a level inside the current candle range is not a target', () => {
    const cfg = config();
    const w = (h: number) => ({ t: 0, o: 1, h, l: 1, c: 1 });
    const state = {
      perTf: {
        '15m': {
          window: [w(118)],
          base: 0,
          pools: [],
          internal: { swings: [] },
          external: { swings: [] },
        },
        '1h': {
          window: [w(100)],
          base: 0,
          pools: [
            { id: 'p-traded', level: 115, kind: 'PDH', side: 'BUY' },
            { id: 'p-open', level: 125, kind: 'PWH', side: 'BUY' },
          ],
          internal: { swings: [] },
          external: { swings: [] },
        },
      },
    } as never;
    expect(collectTargets(state, cfg, '15m', 105, true).map((c) => c.price)).toEqual([125]);
  });
});
