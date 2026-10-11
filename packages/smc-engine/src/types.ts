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
  /** Quality flags (CANDLE_FLAGS); omitted when clean so snapshots stay small. */
  f?: number;
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
  /** Extreme of the current leg since the protected level (high in a bull trend, low in a bear trend). */
  leg: { level: number; barIndex: number } | null;
  lastBreak: { id: string; type: string; time: number } | null;
}

export interface AtrState {
  /** Last ATR values (bounded), for the volatility-regime percentile. */
  hist: number[];
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
  /** Recently confirmed sweeps (bounded), used by the sweep-CHoCH-retest template. */
  sweeps: SweepRecord[];
  /** Recent internal-scale structure breaks (bounded); a setup is created the bar after its break. */
  breaks: BreakRecord[];
}

export interface BreakRecord {
  eventId: string;
  type: 'BOS_UP' | 'BOS_DOWN' | 'CHOCH_UP' | 'CHOCH_DOWN';
  /** Close time of the break candle. */
  time: number;
  breakOpenTime: number;
  /** Absolute bar index where the leg began (the new protected level). */
  legOriginIndex: number;
  bodyAtr: number;
  gapBreak: boolean;
}

export interface SweepRecord {
  poolId: string;
  poolKind: PoolKind;
  side: 'BUY' | 'SELL';
  level: number;
  extreme: number;
  wickOpenTime: number;
  /** Close time at which the sweep was confirmed. */
  confirmedAt: number;
  eventId: string;
  /** Quality flags of the wick candle. */
  flags: number;
}

export type PoolKind = 'EQH' | 'EQL' | 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'SESH' | 'SESL';

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
  /** Session id for SESH/SESL pools. */
  label?: string;
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
  monthStart: number;
  /** Opening prices of the current UTC day/week/month (context levels). */
  dayOpen: number;
  weekOpen: number;
  monthOpen: number;
  /** Running high/low of each session instance in progress. */
  sessions: Record<string, { start: number; high: number; low: number }>;
}

export interface HtfSnapshot {
  closeTime: number;
  trend: Trend;
  protectedLevel: number | null;
  rangeLow: number | null;
  rangeHigh: number | null;
  lastBreakId: string | null;
  lastBreakType: string | null;
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
  /** Shape version; a snapshot with a different version is discarded, never trusted. */
  v: number;
  instrumentId: string;
  perTf: Partial<Record<Timeframe, TfState>>;
  lastCandleOpenTime: Partial<Record<Timeframe, number>>;
  /** External-structure snapshots of the bias timeframes, one per close (bounded). */
  mtf: Partial<Record<Timeframe, HtfSnapshot[]>>;
  /** Live setups (ARMED or TRIGGERED), bounded; closed setups leave state and live in the event stream. */
  setups: SetupRecord[];
}

export interface PlanTargetRecord {
  id: string;
  price: number;
  levelId: string;
  rr: number;
  label: 'TP1' | 'TP2';
}

export interface SetupRecord {
  key: string;
  template: 'T1' | 'T2';
  direction: 'LONG' | 'SHORT';
  entryTf: Timeframe;
  biasTf: Timeframe;
  state: 'ARMED' | 'TRIGGERED';
  grade: 'A' | 'B' | 'C';
  score: number;
  /** Close time of the candle that created the setup. */
  createdAt: number;
  /** Entry-timeframe bar index at creation. */
  createdIndex: number;
  poi: { zoneId: string; kind: 'OB' | 'FVG'; top: number; bottom: number; ref: number };
  stop: number;
  invalidation: number;
  targets: PlanTargetRecord[];
  /** Assumptions the shadow outcome is resolved under. */
  slippage: number;
  feeBps: number;
  /** The price has traded into the point of interest since arming. */
  touched: boolean;
  fill: { time: number; price: number; index: number } | null;
  /** Price extremes since the fill (high and low), for MFE/MAE. */
  hi: number;
  lo: number;
  ambiguous: boolean;
  planHash: string;
}

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };
export type EventData = Readonly<Record<string, Json>>;

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
  | 'LIQ_RUN'
  | 'SETUP_CANDIDATE'
  | 'SETUP_REJECTED'
  | 'SETUP_ARMED'
  | 'PLAN_READY'
  | 'SETUP_TRIGGERED'
  | 'SETUP_EXPIRED'
  | 'SETUP_INVALIDATED'
  | 'SETUP_RESOLVED';

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
