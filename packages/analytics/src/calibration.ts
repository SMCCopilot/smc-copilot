// Calibration (A04 section 13.4): do the rates we displayed match what then happened?

export interface Prediction {
  /** The base rate that was shown with the setup (0..1). */
  predicted: number;
  /** TP1 first = true, stopped = false. */
  hit: boolean;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  observed: number | null;
}

export interface CalibrationReport {
  n: number;
  bins: ReliabilityBin[];
  /** Mean squared error of the predicted rates against 0/1 outcomes (lower is better; 0.25 = always saying 50%). */
  brier: number | null;
  logLoss: number | null;
}

const EPS = 1e-6;

export function calibration(preds: readonly Prediction[], binCount = 10): CalibrationReport {
  const bins: ReliabilityBin[] = Array.from({ length: binCount }, (_, i) => ({
    lo: i / binCount,
    hi: (i + 1) / binCount,
    n: 0,
    meanPredicted: null,
    observed: null,
  }));
  const sums = bins.map(() => ({ p: 0, hit: 0 }));
  let brier = 0;
  let logLoss = 0;
  for (const { predicted, hit } of preds) {
    const p = Math.min(1 - EPS, Math.max(EPS, predicted));
    const idx = Math.min(binCount - 1, Math.floor(predicted * binCount));
    const b = bins[idx] as ReliabilityBin;
    const s = sums[idx] as { p: number; hit: number };
    b.n++;
    s.p += predicted;
    s.hit += hit ? 1 : 0;
    const y = hit ? 1 : 0;
    brier += (predicted - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  bins.forEach((b, i) => {
    const s = sums[i] as { p: number; hit: number };
    if (b.n > 0) {
      b.meanPredicted = s.p / b.n;
      b.observed = s.hit / b.n;
    }
  });
  const n = preds.length;
  return { n, bins, brier: n === 0 ? null : brier / n, logLoss: n === 0 ? null : logLoss / n };
}

/**
 * A cohort whose live-shadow rate falls outside its backtest interval by more than `margin` is UNDER_REVIEW:
 * the UI hides its probability until someone has looked (no silent learning, no silent drift).
 */
export function driftStatus(
  live: { n: number; rate: number },
  backtestCi: readonly [number, number],
  opts: { margin?: number; minN?: number } = {},
): 'ACTIVE' | 'UNDER_REVIEW' {
  const margin = opts.margin ?? 0.05;
  if (live.n < (opts.minN ?? 30)) return 'ACTIVE';
  return live.rate < backtestCi[0] - margin || live.rate > backtestCi[1] + margin
    ? 'UNDER_REVIEW'
    : 'ACTIVE';
}
