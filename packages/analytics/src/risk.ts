// Position sizing and risk warnings (A04 section 10.1). Informational arithmetic on user-supplied inputs:
// "at 1% risk and this stop, size would be X" is never a recommendation to take that size.
import type { RiskCheckResult, RiskProfile, RiskWarning } from '@smc/contracts';

/** Isolated-margin maintenance margin rate used for the approximate liquidation price. [verify per venue] */
export const DEFAULT_MAINTENANCE_MARGIN = 0.005;
export const LEVERAGE_HIGH_ABOVE = 20;
/** Within this fraction of the daily limit the warning is "near". */
export const DAILY_LOSS_NEAR_FRACTION = 0.8;
/** Static correlation group (majors move together far more often than not). Rolling correlation is post-MVP. */
export const CRYPTO_MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'] as const;

export interface PlanRef {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  /** Base asset of the instrument, for the correlation group (e.g. BTC). */
  baseAsset?: string;
}

export interface RiskContext {
  /** Loss already taken today as a percentage of the balance (positive number). */
  todayLossPct?: number;
  openPositions?: readonly { direction: 'LONG' | 'SHORT'; baseAsset: string }[];
  maintenanceMarginRate?: number;
}

const decimals = (step: number): number => {
  let d = 0;
  let s = step;
  while (d < 12 && Math.abs(s - Math.round(s)) > 1e-9) {
    s *= 10;
    d++;
  }
  return d;
};

/** Round down to a multiple of `step` (never rounds a position up into more risk). */
export function floorToStep(value: number, step: number): number {
  // A relative nudge absorbs binary noise (0.3 / 0.1 = 2.9999999999999996) without ever rounding up in practice.
  const floored = Math.floor((value / step) * (1 + 1e-12)) * step;
  return Number(floored.toFixed(decimals(step)));
}

/** Approximate isolated-margin liquidation price. Venue tiers differ: the figure is labelled approximate. */
export function liquidationPrice(
  direction: 'LONG' | 'SHORT',
  entry: number,
  leverage: number,
  mmr = DEFAULT_MAINTENANCE_MARGIN,
): number {
  return direction === 'LONG' ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

export function riskCheck(
  plan: PlanRef,
  profile: RiskProfile,
  ctx: RiskContext = {},
): RiskCheckResult {
  const warnings: RiskWarning[] = [];
  const long = plan.direction === 'LONG';
  const stopDistance = long ? plan.entry - plan.stop : plan.stop - plan.entry;
  if (!(stopDistance > 0)) {
    return { ok: false, warnings: ['SIZE_UNAVAILABLE'] };
  }

  if (profile.riskPerTradePct > profile.maxRiskPerTradePct) warnings.push('RISK_ABOVE_CAP');

  if (profile.dailyLossLimitPct !== undefined && ctx.todayLossPct !== undefined) {
    if (ctx.todayLossPct >= profile.dailyLossLimitPct) warnings.push('DAILY_LOSS_HIT');
    else if (ctx.todayLossPct >= DAILY_LOSS_NEAR_FRACTION * profile.dailyLossLimitPct) {
      warnings.push('DAILY_LOSS_NEAR');
    }
  }
  if (
    profile.maxOpenRiskPct !== undefined &&
    (profile.openRiskPct ?? 0) + profile.riskPerTradePct > profile.maxOpenRiskPct
  ) {
    warnings.push('OPEN_RISK_HIGH');
  }
  if (plan.baseAsset && (CRYPTO_MAJORS as readonly string[]).includes(plan.baseAsset)) {
    const clash = (ctx.openPositions ?? []).some(
      (p) =>
        p.direction === plan.direction &&
        (CRYPTO_MAJORS as readonly string[]).includes(p.baseAsset),
    );
    if (clash) warnings.push('CORRELATED_EXPOSURE');
  }

  let liq: number | undefined;
  if (profile.contractSpec.marketType === 'PERP' && profile.leverage !== undefined) {
    if (profile.leverage > LEVERAGE_HIGH_ABOVE) warnings.push('LEVERAGE_HIGH');
    liq = liquidationPrice(plan.direction, plan.entry, profile.leverage, ctx.maintenanceMarginRate);
    // The venue would close the position before the stop is reached when the liquidation price lies between
    // the entry and the stop.
    if (long ? liq >= plan.stop : liq <= plan.stop) warnings.push('LIQUIDATION_BEFORE_STOP');
  }

  if (profile.balance === undefined) {
    return {
      ok: true,
      warnings: [...warnings, 'SIZE_UNAVAILABLE'],
      ...(liq ? { liquidationPrice: liq } : {}),
    };
  }
  const riskAmount = (profile.balance * profile.riskPerTradePct) / 100;
  // Fee-adjusted: round-trip taker fees add to the loss per unit if the stop is hit.
  const feePerUnit = (2 * profile.takerFeeBps * plan.entry) / 10_000;
  const rawUnits = riskAmount / (stopDistance + feePerUnit);
  const units = floorToStep(rawUnits, profile.contractSpec.quantityStep);
  const notional = units * plan.entry;
  if (
    units <= 0 ||
    (profile.contractSpec.minNotional !== undefined && notional < profile.contractSpec.minNotional)
  ) {
    return {
      ok: true,
      warnings: [...warnings, 'SIZE_UNAVAILABLE'],
      ...(liq ? { liquidationPrice: liq } : {}),
    };
  }
  return {
    ok: true,
    positionSize: { units, riskAmount, notional, basis: 'STOP_DISTANCE' },
    warnings,
    ...(liq ? { liquidationPrice: liq } : {}),
  };
}
