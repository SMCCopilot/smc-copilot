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
  fvgs: Fvg[];
  orderBlocks: OrderBlock[];
  pools: LiquidityPool[];
  pending: PendingSweep[];
  period: PeriodState;
}

export type PoolKind = 'EQH' | 'EQL' | 'PDH' | 'PDL' | 'PWH' | 'PWL';

export interface LiquidityPool {
  id: string;
  kind: PoolKind;
  /** BUY = liquidity above price (highs), SELL = below. */
  side: 'BUY' | 'SELL';
  level: number;
  strength: number;
  createdAt: number;
  /** Open times of the swing bars that make up an equal-level pool. */
  members: number[];
}

export interface PendingSweep {
  poolId: string;
  fromIndex: number;
  fromOpenTime: number;
  extreme: number;
}

/** Running UTC day/week extremes used to create previous-period levels. */
export interface PeriodState {
  dayStart: number;
  dayHigh: number;
  dayLow: number;
  weekStart: number;
  weekHigh: number;
  weekLow: number;
}

export type Dir = 'BULL' | 'BEAR';

export interface Fvg {
  id: string;
  dir: Dir;
  top: number;
  bottom: number;
  ce: number;
  barIndex: number;
  createdAt: number;
  status: 'OPEN' | 'TESTED' | 'FILLED' | 'INVERTED';
  /** Price has closed through the far edge (needed before an inversion retest). */
  closedThrough: boolean;
  displacement: boolean;
  sizeAtr: number;
}

export interface OrderBlock {
  id: string;
  dir: Dir;
  top: number;
  bottom: number;
  barIndex: number;
  /** Open time of the order-block candle. */
  barOpen: number;
  createdAtIndex: number;
  createdAt: number;
  status: 'FRESH' | 'TESTED';
  touches: number;
  inside: boolean;
  displacementRatio: number;
  hasFvgInLeg: boolean;
  sizeAtr: number;
  scale: Scale;
  breakEventId: string;
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
  | 'PROTECTED_UPDATED'
  | 'FVG_BULL'
  | 'FVG_BEAR'
  | 'FVG_TESTED'
  | 'FVG_FILLED'
  | 'FVG_INVERTED'
  | 'FVG_EXPIRED'
  | 'OB_BULL'
  | 'OB_BEAR'
  | 'OB_TESTED'
  | 'OB_MITIGATED'
  | 'OB_EXPIRED'
  | 'POOL_NEW'
  | 'LIQ_SWEEP'
  | 'LIQ_RUN';

export interface EngineEvent {
  /** sha1(instrumentId|tf|type:scale|anchorOpenTime|strategyVersionId): stable across re-runs. */
  id: string;
  type: EngineEventType;
  tf: Timeframe;
  /** Swing scale for swing/structure events; null for zones. */
  scale: Scale | null;
  /** Close time of the candle that made the event knowable. Never earlier than anything it depends on. */
  time: number;
  /** Open time of the candle the event is about (the pivot bar, the break bar). */
  anchorOpenTime: number;
  data: EventData;
}
