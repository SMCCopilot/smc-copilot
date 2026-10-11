// Cohort statistics and base rates (A04 section 8.4). History, not prediction: a rate is shown only when the
// cohort has at least `minN` resolved setups; otherwise there is no number, only a reason.
import type { HistoricalStat } from '@smc/contracts';

export const Z95 = 1.959964;
export const MIN_N = 30;
export const PRIOR_STRENGTH = 10;

/** Wilson score interval for a binomial proportion. n = 0 gives the uninformative [0, 1]. */
export function wilson(wins: number, n: number, z = Z95): [number, number] {
  if (n <= 0) return [0, 1];
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Posterior mean of a Beta prior centred on `priorRate` with `strength` pseudo-observations. */
export const shrunkRate = (
  wins: number,
  n: number,
  priorRate: number,
  strength = PRIOR_STRENGTH,
): number => (wins + strength * priorRate) / (n + strength);

export interface OutcomeRow {
  template: string;
  grade: string;
  direction: 'LONG' | 'SHORT';
  outcome: 'TP1_FIRST' | 'SL_FIRST' | 'INVALIDATED_BEFORE_FILL' | 'EXPIRED_OPEN' | 'NO_FILL';
  filled: boolean;
  realizedR: number | null;
  mfeR: number | null;
  maeR: number | null;
  ambiguousIntrabar: boolean;
}

export interface CohortSummary {
  template: string;
  grade: string;
  /** null = both directions. */
  direction: 'LONG' | 'SHORT' | null;
  /** Armed setups in the cohort (every one gets a shadow outcome). */
  setups: number;
  /** Resolved trades: TP1 first or stopped. Only these enter the win rate. */
  n: number;
  wins: number;
  rate: number;
  ci95: [number, number];
  /** Rate shrunk toward the parent cohort (all grades of the same template and direction). */
  rateShrunk: number;
  avgR: number | null;
  medianMaeR: number | null;
  medianMfeR: number | null;
  /** Filled / armed. */
  fillRate: number;
  /** Resolved trades where one candle touched both stop and target. */
  ambiguityRate: number;
  noFill: number;
  expiredOpen: number;
  sufficient: boolean;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Sum in ascending order so the result does not depend on the order the rows arrived in. */
export const stableSum = (xs: readonly number[]): number =>
  [...xs].sort((a, b) => a - b).reduce((a, b) => a + b, 0);

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : stableSum(xs) / xs.length;

function summarize(
  rows: readonly OutcomeRow[],
  key: Pick<CohortSummary, 'template' | 'grade' | 'direction'>,
  parentRate: number | null,
  minN: number,
): CohortSummary {
  const resolved = rows.filter((r) => r.outcome === 'TP1_FIRST' || r.outcome === 'SL_FIRST');
  const wins = resolved.filter((r) => r.outcome === 'TP1_FIRST').length;
  const n = resolved.length;
  const rate = n === 0 ? 0 : wins / n;
  const realized = resolved.map((r) => r.realizedR).filter((x): x is number => x !== null);
  return {
    ...key,
    setups: rows.length,
    n,
    wins,
    rate,
    ci95: wilson(wins, n),
    rateShrunk: shrunkRate(wins, n, parentRate ?? 0.5),
    avgR: mean(realized),
    medianMaeR: median(resolved.map((r) => r.maeR).filter((x): x is number => x !== null)),
    medianMfeR: median(resolved.map((r) => r.mfeR).filter((x): x is number => x !== null)),
    fillRate: rows.length === 0 ? 0 : rows.filter((r) => r.filled).length / rows.length,
    ambiguityRate: n === 0 ? 0 : resolved.filter((r) => r.ambiguousIntrabar).length / n,
    noFill: rows.filter((r) => r.outcome === 'NO_FILL').length,
    expiredOpen: rows.filter((r) => r.outcome === 'EXPIRED_OPEN').length,
    sufficient: n >= minN,
  };
}

/**
 * One summary per (template, grade, direction) and per (template, grade) over both directions. Setups that
 * were never filled or never resolved are counted but never enter the win rate.
 */
export function summarizeCohorts(rows: readonly OutcomeRow[], minN = MIN_N): CohortSummary[] {
  const out: CohortSummary[] = [];
  const templates = [...new Set(rows.map((r) => r.template))].sort();
  for (const template of templates) {
    const inTemplate = rows.filter((r) => r.template === template);
    const parentOf = (dir: 'LONG' | 'SHORT' | null): number | null => {
      const parent = summarize(
        inTemplate.filter((r) => dir === null || r.direction === dir),
        { template, grade: 'ALL', direction: dir },
        null,
        minN,
      );
      return parent.n > 0 ? parent.rate : null;
    };
    for (const grade of [...new Set(inTemplate.map((r) => r.grade))].sort()) {
      for (const dir of [null, 'LONG', 'SHORT'] as const) {
        const subset = inTemplate.filter(
          (r) => r.grade === grade && (dir === null || r.direction === dir),
        );
        if (subset.length === 0) continue;
        out.push(summarize(subset, { template, grade, direction: dir }, parentOf(dir), minN));
      }
    }
  }
  return out;
}

export type StatReason = 'INSUFFICIENT_HISTORY';

/** The contract object, or null plus a reason. Never a probability from a cohort with n < minN. */
export function toHistoricalStat(
  c: Pick<CohortSummary, 'n' | 'wins' | 'ci95' | 'sufficient'>,
  source: 'LIVE_SHADOW' | 'BACKTEST',
  window: { from: string; to: string },
): { stat: HistoricalStat | null; reason: StatReason | null } {
  if (!c.sufficient || c.n < MIN_N) return { stat: null, reason: 'INSUFFICIENT_HISTORY' };
  return {
    stat: {
      n: c.n,
      rate: c.wins / c.n,
      ci95: [c.ci95[0], c.ci95[1]],
      source,
      window,
      disclaimerKey: 'HISTORICAL_NOT_FORECAST',
    },
    reason: null,
  };
}

/**
 * Rule-based confidence label (A04 section 8.4): never the language model's opinion.
 * HIGH: sufficient, CI narrower than 0.15, clean data and at least 30 live-shadow results.
 * MEDIUM: sufficient but wider, backtest-only, or data not clean. LOW: everything else.
 */
export function confidenceLabel(input: {
  sufficient: boolean;
  ciWidth: number;
  dataClean: boolean;
  liveShadowN: number;
}): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (!input.sufficient) return 'LOW';
  if (input.ciWidth < 0.15 && input.dataClean && input.liveShadowN >= MIN_N) return 'HIGH';
  return 'MEDIUM';
}
