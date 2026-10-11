import { type Candle, DERIVED_TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import type { StoredCandle } from './candle.js';

export { DERIVED_TIMEFRAMES };

const BASE_MS = TIMEFRAME_MS['1m'];

/** Open time of the higher-timeframe bucket that contains `openTime`. UTC boundaries, 1d opens at 00:00 UTC. */
export function bucketStart(openTime: number, tf: Timeframe): number {
  const ms = TIMEFRAME_MS[tf];
  return openTime - (openTime % ms);
}

/** True when a 1m candle opening at `openTime` is the last constituent of its `tf` bucket. */
export function closesBucket(openTime: number, tf: Timeframe): boolean {
  return openTime + BASE_MS === bucketStart(openTime, tf) + TIMEFRAME_MS[tf];
}

/** All 1m open times a `tf` bucket needs. */
export function constituentOpenTimes(bucketOpen: number, tf: Timeframe): number[] {
  const count = TIMEFRAME_MS[tf] / BASE_MS;
  return Array.from({ length: count }, (_, i) => bucketOpen + i * BASE_MS);
}

export interface AggregateResult {
  /** The aggregated candle. `CLOSED` only when every constituent is present; otherwise `INCOMPLETE`. */
  readonly candle: StoredCandle;
  readonly missing: number[];
}

/**
 * Builds the `tf` candle for the bucket opening at `bucketOpen` from its 1m children. Pure and order independent.
 * Open is the first child's open, close the last child's close, high/low the extremes, volume the sum.
 * Quality flags of the children are OR-ed together (a suspect minute makes the hour suspect).
 * With a child missing the result is still produced but marked `INCOMPLETE`, which the engine treats as a data
 * quality warning, never as truth (A03 section 5.3).
 */
export function aggregateBucket(
  children: readonly StoredCandle[],
  bucketOpen: number,
  tf: Timeframe,
): AggregateResult | null {
  const wanted = new Set(constituentOpenTimes(bucketOpen, tf));
  const present = new Map<number, StoredCandle>();
  for (const c of children) if (wanted.has(c.openTime)) present.set(c.openTime, c);
  if (present.size === 0) return null;

  const ordered = [...present.values()].sort((a, b) => a.openTime - b.openTime);
  const first = ordered[0] as StoredCandle;
  const last = ordered[ordered.length - 1] as StoredCandle;
  const missing = [...wanted].filter((t) => !present.has(t)).sort((a, b) => a - b);

  let h = first.h;
  let l = first.l;
  let v = 0;
  let flags = 0;
  for (const c of ordered) {
    if (c.h > h) h = c.h;
    if (c.l < l) l = c.l;
    v += c.v;
    flags |= c.flags;
  }
  const candle: Candle = {
    instrumentId: first.instrumentId,
    tf,
    openTime: bucketOpen,
    o: first.o,
    h,
    l,
    c: last.c,
    v: Math.round(v * 1e8) / 1e8,
    closed: missing.length === 0,
    providerId: last.providerId,
  };
  return {
    candle: { ...candle, flags, status: missing.length === 0 ? 'CLOSED' : 'INCOMPLETE' },
    missing,
  };
}
