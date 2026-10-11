import type { AtrState, CandleLite } from './types.js';

export const emptyAtr = (): AtrState => ({ value: 0, sum: 0, count: 0, prevClose: null });

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
  return { value: fixed ?? value, sum, count, prevClose: bar.c };
}
