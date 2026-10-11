// Multi-timeframe model (A04 section 7.2-7.3): HTF state is snapshotted at each HTF close, so a lower
// timeframe decision at time t only ever reads HTF state as of the last HTF candle closed at or before t.
import { type Candle, type StrategyConfig, TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import { dealingRange } from './ranges.js';
import type { EngineState, HtfSnapshot, ScaleState } from './types.js';

export const MAX_SNAPSHOTS = 64;

export function snapshotOf(closeTime: number, ext: ScaleState, cfg: StrategyConfig): HtfSnapshot {
  const range = dealingRange(ext, cfg);
  return {
    closeTime,
    trend: ext.trend,
    protectedLevel: ext.protected?.level ?? null,
    rangeLow: range?.low ?? null,
    rangeHigh: range?.high ?? null,
    lastBreakId: ext.lastBreak?.id ?? null,
    lastBreakType: ext.lastBreak?.type ?? null,
  };
}

/** HTF state as of time t: the latest snapshot whose candle closed at or before t. */
export function htfAt(state: EngineState, tf: Timeframe, t: number): HtfSnapshot | null {
  const snaps = state.mtf[tf] ?? [];
  for (let i = snaps.length - 1; i >= 0; i--) {
    const s = snaps[i] as HtfSnapshot;
    if (s.closeTime <= t) return s;
  }
  return null;
}

export interface Bias {
  trend: 'BULL' | 'BEAR' | 'RANGE';
  perTf: { tf: Timeframe; trend: HtfSnapshot['trend'] | 'NONE' }[];
}

/** BULL if every bias timeframe's external trend is bull, BEAR if all bear, otherwise RANGE. */
export function biasAt(state: EngineState, cfg: StrategyConfig, t: number): Bias {
  const perTf = cfg.timeframes.bias.map((tf) => ({
    tf,
    trend: htfAt(state, tf, t)?.trend ?? ('NONE' as const),
  }));
  const all = (trend: string): boolean => perTf.length > 0 && perTf.every((p) => p.trend === trend);
  return { trend: all('BULL') ? 'BULL' : all('BEAR') ? 'BEAR' : 'RANGE', perTf };
}

export const closeTimeOf = (c: Pick<Candle, 'tf' | 'openTime'>): number =>
  c.openTime + TIMEFRAME_MS[c.tf];

/**
 * Canonical processing order: by close time, then the higher timeframe first, so a 1h candle closing at
 * 10:00 is processed before the 5m candle closing at 10:00 (A04 section 2.1).
 */
export function orderByClose<T extends Pick<Candle, 'tf' | 'openTime'>>(
  candles: readonly T[],
): T[] {
  return [...candles].sort(
    (a, b) =>
      closeTimeOf(a) - closeTimeOf(b) ||
      TIMEFRAME_MS[b.tf] - TIMEFRAME_MS[a.tf] ||
      (a.tf < b.tf ? -1 : a.tf > b.tf ? 1 : 0),
  );
}
