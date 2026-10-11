// Dealing range, premium/discount and the OTE band (A04 section 7.1).
import type { StrategyConfig } from '@smc/contracts';
import type { ScaleState, Trend } from './types.js';

export interface DealingRange {
  trend: Exclude<Trend, 'UNDEFINED'>;
  low: number;
  high: number;
  /** Equilibrium: the 50% level. */
  eq: number;
  /** Retracement band measured from the leg extreme (bull: down from the high, bear: up from the low). */
  ote: { bottom: number; top: number };
}

/** The most recent external leg: from the protected level to the leg extreme. Null until a trend exists. */
export function dealingRange(scale: ScaleState, cfg: StrategyConfig): DealingRange | null {
  if (scale.trend === 'UNDEFINED' || !scale.protected || !scale.leg) return null;
  const bull = scale.trend === 'BULL';
  const low = bull ? scale.protected.level : scale.leg.level;
  const high = bull ? scale.leg.level : scale.protected.level;
  const size = high - low;
  if (!(size > 0)) return null;
  const { oteLow, oteHigh } = cfg.range;
  const ote = bull
    ? { bottom: high - oteHigh * size, top: high - oteLow * size }
    : { bottom: low + oteLow * size, top: low + oteHigh * size };
  return { trend: scale.trend, low, high, eq: low + size / 2, ote };
}

export interface PremiumDiscount {
  zone: 'PREMIUM' | 'DISCOUNT' | 'EQ';
  /** Position in the range, clamped to 0..1 (0 = range low). */
  pct: number;
}

export function premiumDiscount(price: number, range: DealingRange): PremiumDiscount {
  const raw = (price - range.low) / (range.high - range.low);
  const pct = Math.min(1, Math.max(0, raw));
  return { zone: raw > 0.5 ? 'PREMIUM' : raw < 0.5 ? 'DISCOUNT' : 'EQ', pct };
}
