import type { Timeframe } from '@smc/contracts';

export type Scale = 'internal' | 'external';
export type Trend = 'BULL' | 'BEAR' | 'UNDEFINED';

/** The slice of a candle the engine keeps. `t` is the OPEN time (epoch ms UTC). */
export interface CandleLite {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Swing {
  id: string;
  kind: 'HIGH' | 'LOW';
  level: number;
  /** Absolute bar index within the timeframe's stream. */
  barIndex: number;
  barOpenTime: number;
  /** Close time of the bar that confirmed the pivot (barOpenTime + R bars + one bar). */
  confirmedAt: number;
  broken: boolean;
}

export interface ProtectedLevel {
  level: number;
  barIndex: number;
  /** True while the level is the raw extreme of the span rather than a confirmed swing. */
  provisional: boolean;
  /** Span searched for a confirmed swing while provisional. */
  spanFrom: number;
  spanTo: number;
}

export interface ScaleState {
  swings: Swing[];
  trend: Trend;
  /** Bull: the swing low whose close-break is a CHoCH. Bear: the swing high. */
  protected: ProtectedLevel | null;
}

export interface AtrState {
  value: number;
  sum: number;
  count: number;
  prevClose: number | null;
}

export interface TfState {
  window: CandleLite[];
  /** Absolute index of window[0]. The next bar has index base + window.length. */
  base: number;
  atr: AtrState;
  internal: ScaleState;
  external: ScaleState;
}

export interface EngineState {
  v: 1;
  instrumentId: string;
  perTf: Partial<Record<Timeframe, TfState>>;
  lastCandleOpenTime: Partial<Record<Timeframe, number>>;
}

export type EventData = Readonly<Record<string, string | number | boolean | null>>;

export type EngineEventType =
  | 'SWING_HIGH'
  | 'SWING_LOW'
  | 'TREND_INIT'
  | 'BOS_UP'
  | 'BOS_DOWN'
  | 'CHOCH_UP'
  | 'CHOCH_DOWN'
  | 'PROTECTED_UPDATED';

export interface EngineEvent {
  /** sha1(instrumentId|tf|type:scale|anchorOpenTime|strategyVersionId): stable across re-runs. */
  id: string;
  type: EngineEventType;
  tf: Timeframe;
  scale: Scale;
  /** Close time of the candle that made the event knowable. Never earlier than anything it depends on. */
  time: number;
  /** Open time of the candle the event is about (the pivot bar, the break bar). */
  anchorOpenTime: number;
  data: EventData;
}
