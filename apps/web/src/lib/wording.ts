import type { ReasonCode } from '@smc/contracts';

/** Product wording: scenarios, never "buy" or "sell", and no certainty words. */
export const directionLabel = (d: 'LONG' | 'SHORT'): string =>
  d === 'LONG' ? 'Long scenario' : 'Short scenario';

export const SCENARIO_KIND: Record<string, string> = {
  CONTINUATION: 'Continuation',
  REVERSAL: 'Reversal',
  POI_FAILS: 'Point of interest fails',
  SWEEP_NOT_REVERSAL: 'Sweep is not a reversal',
};
export const CONDITION: Record<string, string> = {
  CLOSE_ABOVE: 'Close above',
  CLOSE_BELOW: 'Close below',
  TRADES_INTO: 'Trades into',
};

/** One entry per contract reason code, so a new code is a compile error here. */
const REASONS: Record<ReasonCode, string> = {
  DATA_STALE: 'Market data was not fresh enough',
  DATA_SUSPECT: 'Some candles looked unreliable',
  POI_MITIGATED: 'Price already returned to the zone',
  WRONG_PD_SIDE: 'Zone is on the wrong side of the range (premium or discount)',
  STOP_TOO_TIGHT: 'Stop would be too close to the entry',
  STOP_TOO_WIDE: 'Stop would be too far from the entry',
  RR_TOO_LOW: 'Reward to risk was too low',
  NO_TARGET: 'No clear target level',
  SPREAD_WIDE: 'Spread was too wide',
  VOL_EXTREME: 'Volatility was extreme',
  NEWS_WINDOW: 'Inside a news window',
  SETUP_EXPIRED: 'The scenario expired',
  HTF_COUNTER_BIAS: 'Against the higher timeframe bias',
  NO_POI: 'No point of interest',
  POI_INVALIDATED: 'The zone was invalidated',
  INVALIDATION_BREACHED: 'The invalidation level was breached',
  TARGET_REACHED_FIRST: 'The target was reached before entry',
};
export const reasonText = (code: string): string =>
  REASONS[code as ReasonCode] ?? code.replaceAll('_', ' ').toLowerCase();

export const percent = (r: number): string => `${(r * 100).toFixed(0)}%`;
