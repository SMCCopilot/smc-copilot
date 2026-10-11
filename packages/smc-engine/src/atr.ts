import type { AtrState, CandleLite } from './types.js';

export const ATR_HISTORY = 200;

/** Fraction (0..1) of the recent ATR history at or below the current value. */
export function atrPercentile(atr: AtrState): number {
  if (atr.hist.length === 0) return 0;
  let below = 0;
  for (const v of atr.hist) if (v <= atr.value) below++;
  return below / atr.hist.length;
}

export const emptyAtr = (): AtrState => ({ hist: [], value: 0, sum: 0, count: 0, prevClose: null });

/**
 * Wilder ATR. The first `period` bars use the running mean of true range, then Wilder smoothing.
 * `fixed` pins the value for hand-checkable fixtures; it is never set in a shipped strategy version.
 */
export function updateAtr(
  prev: AtrState,
  bar: CandleLite,
  period: number,
  fixed: number | undefined,
): AtrState {
  const tr =
    prev.prevClose === null
      ? bar.h - bar.l
      : Math.max(bar.h - bar.l, Math.abs(bar.h - prev.prevClose), Math.abs(bar.l - prev.prevClose));
  const count = prev.count + 1;
  let sum = prev.sum;
  let value: number;
  if (count <= period) {
    sum += tr;
    value = sum / count;
  } else {
    value = (prev.value * (period - 1) + tr) / period;
  }
  const v = fixed ?? value;
  const hist = prev.hist.length >= ATR_HISTORY ? [...prev.hist.slice(1), v] : [...prev.hist, v];
  return { hist, value: v, sum, count, prevClose: bar.c };
}
