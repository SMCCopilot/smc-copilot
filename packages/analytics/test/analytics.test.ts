import { RiskCheckResultSchema, RiskProfileSchema } from '@smc/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bootstrapMeanCi,
  calibration,
  confidenceLabel,
  driftStatus,
  floorToStep,
  liquidationPrice,
  maxDrawdownR,
  mulberry32,
  type OutcomeRow,
  riskCheck,
  runBacktest,
  shrunkRate,
  splitByTime,
  summarizeCohorts,
  type Trade,
  toHistoricalStat,
  wilson,
} from '../src/index.js';

describe('Wilson interval and base rates', () => {
  it('n = 40, 16 wins gives rate 0.400 and a CI of about 0.26 to 0.55', () => {
    const [lo, hi] = wilson(16, 40);
    expect(lo).toBeCloseTo(0.2638, 3);
    expect(hi).toBeCloseTo(0.5541, 3);
    const s = toHistoricalStat(
      { n: 40, wins: 16, ci95: [lo, hi], sufficient: true },
      'LIVE_SHADOW',
      {
        from: '2026-01-01',
        to: '2026-02-01',
      },
    );
    expect(s.stat?.rate).toBe(0.4);
    expect(s.reason).toBeNull();
  });

  it('n = 29 returns no historical stat and INSUFFICIENT_HISTORY', () => {
    const [lo, hi] = wilson(20, 29);
    expect(
      toHistoricalStat({ n: 29, wins: 20, ci95: [lo, hi], sufficient: false }, 'BACKTEST', {
        from: 'a',
        to: 'b',
      }),
    ).toEqual({
      stat: null,
      reason: 'INSUFFICIENT_HISTORY',
    });
  });

  it('refuses a probability even if a caller wrongly marks a small cohort sufficient', () => {
    expect(
      toHistoricalStat({ n: 12, wins: 12, ci95: [0.7, 1], sufficient: true }, 'BACKTEST', {
        from: 'a',
        to: 'b',
      }).stat,
    ).toBeNull();
  });

  it('is well-formed for any wins and n', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (w, extra) => {
          const n = w + extra;
          const [lo, hi] = wilson(w, n);
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(hi).toBeLessThanOrEqual(1);
          expect(lo).toBeLessThanOrEqual(hi);
          if (n > 0) {
            expect(lo).toBeLessThanOrEqual(w / n + 1e-12);
            expect(hi).toBeGreaterThanOrEqual(w / n - 1e-12);
          }
        },
      ),
    );
  });

  it('shrinks a tiny perfect record toward the parent rate (3 for 3 is not 100%)', () => {
    expect(shrunkRate(3, 3, 0.4)).toBeCloseTo((3 + 10 * 0.4) / 13, 10);
    expect(shrunkRate(3, 3, 0.4)).toBeLessThan(0.6);
  });

  it('confidence is rule-based: HIGH needs sufficient, a narrow CI, clean data and 30 live results', () => {
    const base = { sufficient: true, ciWidth: 0.1, dataClean: true, liveShadowN: 40 };
    expect(confidenceLabel(base)).toBe('HIGH');
    expect(confidenceLabel({ ...base, ciWidth: 0.2 })).toBe('MEDIUM');
    expect(confidenceLabel({ ...base, liveShadowN: 5 })).toBe('MEDIUM'); // backtest only
    expect(confidenceLabel({ ...base, dataClean: false })).toBe('MEDIUM');
    expect(confidenceLabel({ ...base, sufficient: false })).toBe('LOW');
  });
});

describe('cohort summaries', () => {
  const row = (o: Partial<OutcomeRow>): OutcomeRow => ({
    template: 'T1',
    grade: 'A',
    direction: 'LONG',
    outcome: 'TP1_FIRST',
    filled: true,
    realizedR: 2,
    mfeR: 3,
    maeR: 0.2,
    ambiguousIntrabar: false,
    ...o,
  });
  const rows = [
    ...Array.from({ length: 16 }, () => row({})),
    ...Array.from({ length: 24 }, () =>
      row({ outcome: 'SL_FIRST', realizedR: -1.1, mfeR: 0.4, maeR: 1.1 }),
    ),
    ...Array.from({ length: 10 }, () =>
      row({ outcome: 'NO_FILL', filled: false, realizedR: null, mfeR: null, maeR: null }),
    ),
    row({ outcome: 'EXPIRED_OPEN', realizedR: null }),
  ];

  it('counts only resolved trades in the win rate; no-fills and open expiries are reported separately', () => {
    const c = summarizeCohorts(rows).find(
      (x) => x.template === 'T1' && x.grade === 'A' && x.direction === null,
    );
    expect(c).toMatchObject({
      setups: 51,
      n: 40,
      wins: 16,
      rate: 0.4,
      noFill: 10,
      expiredOpen: 1,
      sufficient: true,
    });
    expect(c?.fillRate).toBeCloseTo(41 / 51, 6);
    expect(c?.avgR).toBeCloseTo((16 * 2 + 24 * -1.1) / 40, 6);
    expect(c?.medianMaeR).toBeCloseTo(1.1, 6);
  });

  it('splits by direction and marks small cohorts insufficient', () => {
    const mixed = [...rows, ...Array.from({ length: 5 }, () => row({ direction: 'SHORT' }))];
    const short = summarizeCohorts(mixed).find((x) => x.direction === 'SHORT');
    expect(short).toMatchObject({ n: 5, sufficient: false });
  });

  it('is deterministic and order independent', () => {
    const shuffled = [...rows].reverse();
    expect(summarizeCohorts(shuffled)).toEqual(summarizeCohorts(rows));
  });
});

describe('risk sizing', () => {
  const profile = (over: Record<string, unknown> = {}) =>
    RiskProfileSchema.parse({
      accountCurrency: 'USDT',
      balance: 10_000,
      riskPerTradePct: 1,
      contractSpec: { marketType: 'SPOT', quantityStep: 0.001 },
      takerFeeBps: 0,
      ...over,
    });
  const long = { direction: 'LONG' as const, entry: 100, stop: 95, baseAsset: 'BTC' };

  it('sizes from the stop distance and rounds DOWN to the quantity step', () => {
    const r = riskCheck(long, profile());
    // risk 100 / distance 5 = 20 units exactly
    expect(r.positionSize).toMatchObject({
      units: 20,
      riskAmount: 100,
      notional: 2000,
      basis: 'STOP_DISTANCE',
    });
    const odd = riskCheck({ ...long, stop: 93 }, profile()); // 100 / 7 = 14.2857...
    expect(odd.positionSize?.units).toBe(14.285);
    expect(() => RiskCheckResultSchema.parse(odd)).not.toThrow();
  });

  it('reduces the size by round-trip fees', () => {
    const r = riskCheck(long, profile({ takerFeeBps: 5 }));
    // fee per unit = 2 x 5bps x 100 = 0.1, so units = 100 / 5.1
    expect(r.positionSize?.units).toBe(19.607);
  });

  it('floorToStep never rounds up', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.constantFrom(0.001, 0.01, 0.1, 1, 5),
        (v, step) => {
          expect(floorToStep(v, step)).toBeLessThanOrEqual(v * (1 + 1e-12) + 1e-12);
          expect(v - floorToStep(v, step)).toBeLessThan(step + 1e-9);
        },
      ),
    );
  });

  it('has no size without a balance, below the minimum notional, or with an unusable stop', () => {
    expect(riskCheck(long, profile({ balance: undefined })).warnings).toContain('SIZE_UNAVAILABLE');
    const tiny = riskCheck(
      long,
      profile({
        balance: 1,
        contractSpec: { marketType: 'SPOT', quantityStep: 0.001, minNotional: 10 },
      }),
    );
    expect(tiny.positionSize).toBeUndefined();
    expect(tiny.warnings).toContain('SIZE_UNAVAILABLE');
    expect(riskCheck({ ...long, stop: 101 }, profile())).toMatchObject({ ok: false });
  });

  it('warns about risk above the cap, daily loss, open risk and correlated exposure', () => {
    const p = profile({
      riskPerTradePct: 3,
      maxRiskPerTradePct: 2,
      dailyLossLimitPct: 5,
      maxOpenRiskPct: 4,
      openRiskPct: 2,
    });
    const r = riskCheck(long, p, {
      todayLossPct: 4.2,
      openPositions: [{ direction: 'LONG', baseAsset: 'ETH' }],
    });
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        'RISK_ABOVE_CAP',
        'DAILY_LOSS_NEAR',
        'OPEN_RISK_HIGH',
        'CORRELATED_EXPOSURE',
      ]),
    );
    expect(riskCheck(long, p, { todayLossPct: 5 }).warnings).toContain('DAILY_LOSS_HIT');
    const opposite = riskCheck(long, profile(), {
      openPositions: [{ direction: 'SHORT', baseAsset: 'ETH' }],
    });
    expect(opposite.warnings).not.toContain('CORRELATED_EXPOSURE');
  });

  it('warns when the venue would liquidate the position before the stop (long and short)', () => {
    const perp = (lev: number) =>
      profile({ contractSpec: { marketType: 'PERP', quantityStep: 0.001 }, leverage: lev });
    // 20x long at 100: liq = 100 x (1 - 0.05 + 0.005) = 95.5, above the 95 stop
    expect(liquidationPrice('LONG', 100, 20)).toBeCloseTo(95.5, 10);
    const hit = riskCheck(long, perp(20));
    expect(hit.warnings).toContain('LIQUIDATION_BEFORE_STOP');
    expect(hit.liquidationPrice).toBeCloseTo(95.5, 10);
    expect(riskCheck(long, perp(10)).warnings).not.toContain('LIQUIDATION_BEFORE_STOP'); // liq 90.5 is beyond the stop
    // 20x short at 100: liq = 100 x (1 + 0.05 - 0.005) = 104.5, below a 105 stop
    expect(riskCheck({ direction: 'SHORT', entry: 100, stop: 105 }, perp(20)).warnings).toContain(
      'LIQUIDATION_BEFORE_STOP',
    );
    expect(riskCheck(long, perp(25)).warnings).toContain('LEVERAGE_HIGH');
    expect(riskCheck(long, profile()).liquidationPrice).toBeUndefined(); // spot: no liquidation
  });
});

describe('calibration', () => {
  it('reports reliability bins, Brier and log loss', () => {
    const preds = [
      ...Array.from({ length: 10 }, (_, i) => ({ predicted: 0.4, hit: i < 4 })),
      ...Array.from({ length: 10 }, (_, i) => ({ predicted: 0.7, hit: i < 7 })),
    ];
    const r = calibration(preds);
    expect(r.n).toBe(20);
    expect(r.bins[4]).toMatchObject({ n: 10, observed: 0.4 });
    expect(r.bins[4]?.meanPredicted).toBeCloseTo(0.4, 12);
    expect(r.bins[7]).toMatchObject({ n: 10, observed: 0.7 });
    expect(r.brier).toBeCloseTo(0.5 * (0.24 + 0.21), 10);
    expect(r.logLoss).toBeGreaterThan(0);
  });

  it('a constant 50% forecast scores a Brier of 0.25, the no-skill baseline', () => {
    const r = calibration(
      Array.from({ length: 100 }, (_, i) => ({ predicted: 0.5, hit: i % 2 === 0 })),
    );
    expect(r.brier).toBeCloseTo(0.25, 10);
    expect(calibration([]).brier).toBeNull();
  });

  it('flags a cohort whose live rate drifts outside its backtest interval', () => {
    expect(driftStatus({ n: 50, rate: 0.2 }, [0.4, 0.6])).toBe('UNDER_REVIEW');
    expect(driftStatus({ n: 50, rate: 0.5 }, [0.4, 0.6])).toBe('ACTIVE');
    expect(driftStatus({ n: 10, rate: 0.0 }, [0.4, 0.6])).toBe('ACTIVE'); // too few to judge
  });
});

describe('backtest evaluation', () => {
  const DAY = 86_400_000;
  const trades = (n: number, edge: number, seed = 1): Trade[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, (_, i) => {
      const win = rnd() < 0.5 + edge;
      return {
        key: `k${i}`,
        template: i % 2 === 0 ? 'T1' : 'T2',
        grade: 'A',
        direction: 'LONG',
        createdAt: Math.floor((i / n) * 360 * DAY),
        resolutionTime: Math.floor((i / n) * 360 * DAY) + 3_600_000,
        realizedR: win ? 1.0 : -1.1, // costs make a fair coin lose
        win,
      };
    });
  };
  const range = { from: 0, to: 360 * DAY };
  const criteria = { minTrades: 30, lowerBoundAbove: 0, minPositiveWindows: 2, windows: 3 };

  it('splits time into contiguous tune / validate / test ranges', () => {
    const s = splitByTime(range);
    expect(s.tune).toEqual({ from: 0, to: 180 * DAY });
    expect(s.validate).toEqual({ from: 180 * DAY, to: 270 * DAY });
    expect(s.test).toEqual({ from: 270 * DAY, to: 360 * DAY });
  });

  it('bootstrap intervals are reproducible for a seed and null for tiny samples', () => {
    const xs = trades(60, 0).map((t) => t.realizedR);
    expect(bootstrapMeanCi(xs, { seed: 3 })).toEqual(bootstrapMeanCi(xs, { seed: 3 }));
    expect(bootstrapMeanCi([1])).toBeNull();
  });

  it('max drawdown is the worst peak-to-trough fall of cumulative R in resolution order', () => {
    const t = (r: number, i: number): Trade => ({
      key: `${i}`,
      template: 'T1',
      grade: 'A',
      direction: 'LONG',
      createdAt: i,
      resolutionTime: i,
      realizedR: r,
      win: r > 0,
    });
    expect(maxDrawdownR([t(2, 1), t(-1, 2), t(-1, 3), t(3, 4), t(-2, 5)])).toBe(2);
    expect(maxDrawdownR([])).toBe(0);
  });

  it('reports NO_EDGE_DETECTED for a coin-flip strategy with costs (a valid result)', () => {
    const r = runBacktest(trades(900, 0), range, criteria, { trialsCount: 2 });
    expect(r.verdict).toBe('NO_EDGE_DETECTED');
    expect(r.test.find((g) => g.label === 'ALL')?.pass).toBe(false);
  });

  it('can support an edge when one clearly exists, and the haircut widens the interval with more trials', () => {
    const edge = trades(900, 0.2);
    const one = runBacktest(edge, range, criteria, { trialsCount: 1 });
    const many = runBacktest(edge, range, criteria, { trialsCount: 20 });
    expect(one.verdict).toBe('EDGE_SUPPORTED');
    const ci1 = one.test[0]?.expectancyCi as [number, number];
    const ci20 = many.test[0]?.expectancyCi as [number, number];
    expect(ci20[1] - ci20[0]).toBeGreaterThan(ci1[1] - ci1[0]);
    expect(many.adjustedAlpha).toBeCloseTo(0.05 / 20, 12);
  });

  it('says INSUFFICIENT_DATA instead of passing or failing a thin sample', () => {
    const r = runBacktest(trades(40, 0.3), range, criteria, { trialsCount: 1 });
    expect(r.verdict).toBe('INSUFFICIENT_DATA');
  });

  it('cannot pass on a few lucky windows: needs positive windows as well', () => {
    const lucky = trades(900, 0.2).map((t) =>
      t.createdAt >= 270 * DAY + 60 * DAY ? { ...t, realizedR: -1, win: false } : t,
    );
    const r = runBacktest(lucky, range, { ...criteria, minPositiveWindows: 3 }, { trialsCount: 1 });
    expect(r.test.find((g) => g.label === 'ALL')?.failures.join(' ')).toMatch(/windows/);
  });
});
