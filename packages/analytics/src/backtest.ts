// Backtest evaluation (A04 section 15.3): walk-forward splits by time, pre-registered criteria, a trials counter
// with a multiple-testing adjustment, costs already inside the trades (spread, slippage, fees, pessimistic
// intrabar rule), bootstrap confidence intervals and drawdown. "No edge detected" is a valid result.

/** One resolved, filled trade (net R after costs). */
export interface Trade {
  key: string;
  template: string;
  grade: string;
  direction: 'LONG' | 'SHORT';
  /** Close time of the candle that created the setup. */
  createdAt: number;
  resolutionTime: number;
  /** Net R after round-trip fees. */
  realizedR: number;
  win: boolean;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b).reduce((a, b) => a + b, 0) / xs.length;

/** Percentile bootstrap interval of the mean. Two-sided at `alpha` (0.05 = 95%). Null with fewer than 2 values. */
export function bootstrapMeanCi(
  values: readonly number[],
  opts: { iterations?: number; seed?: number; alpha?: number } = {},
): [number, number] | null {
  if (values.length < 2) return null;
  const iterations = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rnd = mulberry32(opts.seed ?? 1);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++)
      sum += values[Math.floor(rnd() * values.length)] as number;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * iterations)] as number;
  const hi = means[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))] as number;
  return [lo, hi];
}

/** Largest peak-to-trough fall of cumulative R, trades taken in resolution order. */
export function maxDrawdownR(trades: readonly Trade[]): number {
  let peak = 0;
  let cum = 0;
  let worst = 0;
  for (const t of [...trades].sort(
    (a, b) => a.resolutionTime - b.resolutionTime || (a.key < b.key ? -1 : 1),
  )) {
    cum += t.realizedR;
    peak = Math.max(peak, cum);
    worst = Math.max(worst, peak - cum);
  }
  return worst;
}

export interface TimeRange {
  from: number;
  /** Exclusive. */
  to: number;
}
export interface Split {
  tune: TimeRange;
  validate: TimeRange;
  test: TimeRange;
}

/** Contiguous walk-forward ranges (tune, validate, final test); the final test is never used while designing. */
export function splitByTime(
  range: TimeRange,
  fractions: readonly [number, number, number] = [0.5, 0.25, 0.25],
): Split {
  const total = fractions[0] + fractions[1] + fractions[2];
  const span = range.to - range.from;
  const a = range.from + Math.floor((span * fractions[0]) / total);
  const b = range.from + Math.floor((span * (fractions[0] + fractions[1])) / total);
  return {
    tune: { from: range.from, to: a },
    validate: { from: a, to: b },
    test: { from: b, to: range.to },
  };
}

/** Acceptance criteria, written down BEFORE the final-test period is looked at (docs/backtest-criteria.md). */
export interface Criteria {
  /** Minimum filled-and-resolved trades in the final-test period. */
  minTrades: number;
  /** The lower confidence bound of net expectancy (R) must exceed this. */
  lowerBoundAbove: number;
  /** In at least this many of `windows` equal time slices the mean net R must be positive. */
  minPositiveWindows: number;
  windows: number;
}

export interface GroupResult {
  label: string;
  n: number;
  wins: number;
  winRate: number | null;
  expectancyR: number | null;
  /** Bootstrap interval of expectancy at the multiple-testing adjusted alpha. */
  expectancyCi: [number, number] | null;
  maxDrawdownR: number;
  positiveWindows: number;
  windows: number;
  /** Only set for the final-test evaluation. */
  pass: boolean | null;
  failures: string[];
}

const inRange = (t: Trade, r: TimeRange): boolean => t.createdAt >= r.from && t.createdAt < r.to;

export function evaluateGroup(
  label: string,
  trades: readonly Trade[],
  range: TimeRange,
  opts: { criteria?: Criteria; alpha: number; seed: number; windows: number },
): GroupResult {
  const mine = trades.filter((t) => inRange(t, range));
  const rs = mine.map((t) => t.realizedR);
  const span = range.to - range.from;
  let positiveWindows = 0;
  for (let w = 0; w < opts.windows; w++) {
    const slice = {
      from: range.from + (span * w) / opts.windows,
      to: range.from + (span * (w + 1)) / opts.windows,
    };
    const inSlice = mine.filter((t) => t.createdAt >= slice.from && t.createdAt < slice.to);
    if (inSlice.length > 0 && mean(inSlice.map((t) => t.realizedR)) > 0) positiveWindows++;
  }
  const ci = bootstrapMeanCi(rs, { alpha: opts.alpha, seed: opts.seed });
  const failures: string[] = [];
  let pass: boolean | null = null;
  if (opts.criteria) {
    const c = opts.criteria;
    if (mine.length < c.minTrades)
      failures.push(`fewer than ${c.minTrades} trades (${mine.length})`);
    if (ci === null || ci[0] <= c.lowerBoundAbove) {
      failures.push(`expectancy lower bound is not above ${c.lowerBoundAbove} R`);
    }
    if (positiveWindows < c.minPositiveWindows) {
      failures.push(
        `positive in ${positiveWindows} of ${opts.windows} windows (need ${c.minPositiveWindows})`,
      );
    }
    pass = failures.length === 0;
  }
  return {
    label,
    n: mine.length,
    wins: mine.filter((t) => t.win).length,
    winRate: mine.length === 0 ? null : mine.filter((t) => t.win).length / mine.length,
    expectancyR: mine.length === 0 ? null : mean(rs),
    expectancyCi: ci,
    maxDrawdownR: maxDrawdownR(mine),
    positiveWindows,
    windows: opts.windows,
    pass,
    failures,
  };
}

export interface BacktestResults {
  split: Split;
  trialsCount: number;
  /** alpha / trialsCount: the interval widens with every variant tried (multiple-testing haircut). */
  adjustedAlpha: number;
  criteria: Criteria;
  seed: number;
  tune: GroupResult[];
  validate: GroupResult[];
  /** Evaluated against the criteria. Look at it once. */
  test: GroupResult[];
  /** True only if every template that has a verdict passed. Zero templates tested = no verdict. */
  verdict: 'EDGE_SUPPORTED' | 'NO_EDGE_DETECTED' | 'INSUFFICIENT_DATA';
}

export function runBacktest(
  trades: readonly Trade[],
  range: TimeRange,
  criteria: Criteria,
  opts: {
    trialsCount: number;
    seed?: number;
    alpha?: number;
    fractions?: readonly [number, number, number];
  },
): BacktestResults {
  const seed = opts.seed ?? 1;
  const alpha = (opts.alpha ?? 0.05) / Math.max(1, opts.trialsCount);
  const split = splitByTime(range, opts.fractions);
  const templates = [...new Set(trades.map((t) => t.template))].sort();
  const groups = (r: TimeRange, withCriteria: boolean): GroupResult[] =>
    ['ALL', ...templates].map((tpl) =>
      evaluateGroup(tpl, tpl === 'ALL' ? trades : trades.filter((t) => t.template === tpl), r, {
        ...(withCriteria ? { criteria } : {}),
        alpha,
        seed,
        windows: criteria.windows,
      }),
    );
  const test = groups(split.test, true);
  const tested = test.filter((g) => g.label !== 'ALL' && g.n > 0);
  const verdict: BacktestResults['verdict'] =
    tested.length === 0 || tested.every((g) => g.n < criteria.minTrades)
      ? 'INSUFFICIENT_DATA'
      : tested.some((g) => g.pass)
        ? 'EDGE_SUPPORTED'
        : 'NO_EDGE_DETECTED';
  return {
    split,
    trialsCount: opts.trialsCount,
    adjustedAlpha: alpha,
    criteria,
    seed,
    tune: groups(split.tune, false),
    validate: groups(split.validate, false),
    test,
    verdict,
  };
}
