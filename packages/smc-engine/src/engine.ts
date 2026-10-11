import { type Candle, type StrategyConfig, TIMEFRAME_MS } from '@smc/contracts';
import { emptyAtr, updateAtr } from './atr.js';
import { emptyPeriod, stepLiquidity } from './liquidity.js';
import { emptyScale, stepScale } from './scale.js';
import type { CandleLite, EngineEvent, EngineState, Swing, TfState } from './types.js';
import { type BreakInfo, stepZones } from './zones.js';

export const WINDOW_BARS = 600;

export function createEngine(instrumentId: string): EngineState {
  return { v: 1, instrumentId, perTf: {}, lastCandleOpenTime: {} };
}

const emptyTf = (): TfState => ({
  window: [],
  base: 0,
  atr: emptyAtr(),
  internal: emptyScale(),
  external: emptyScale(),
  fvgs: [],
  orderBlocks: [],
  pools: [],
  pending: [],
  period: emptyPeriod(),
});

/**
 * The reducer (A04 section 2.1): pure, no clock, no I/O. Feed candles of one instrument in close-time
 * order. Open candles, other instruments' candles are rejected/ignored; a candle at or before the last
 * processed open time of its timeframe is ignored, so replays are idempotent.
 */
export function step(
  state: EngineState,
  candle: Candle,
  cfg: StrategyConfig,
): { state: EngineState; events: EngineEvent[] } {
  if (candle.instrumentId !== state.instrumentId) {
    throw new Error(`candle for ${candle.instrumentId} fed to engine for ${state.instrumentId}`);
  }
  const tf = candle.tf;
  const last = state.lastCandleOpenTime[tf];
  if (!candle.closed || !cfg.timeframes.analysis.includes(tf)) return { state, events: [] };
  if (last !== undefined && candle.openTime <= last) return { state, events: [] };

  const prev = state.perTf[tf] ?? emptyTf();
  const bar: CandleLite = {
    t: candle.openTime,
    o: candle.o,
    h: candle.h,
    l: candle.l,
    c: candle.c,
  };
  const grown = [...prev.window, bar];
  const drop = Math.max(0, grown.length - WINDOW_BARS);
  const bars = drop > 0 ? grown.slice(drop) : grown;
  const base = prev.base + drop;
  const n = base + bars.length - 1;
  const atr = updateAtr(prev.atr, bar, cfg.atr.period, cfg.atr.fixed);

  const ctx = {
    instrumentId: state.instrumentId,
    tf,
    tfMs: TIMEFRAME_MS[tf],
    cfg,
    window: bars,
    base,
    n,
    prevClose: prev.atr.prevClose,
    atr: atr.value,
  };
  const internal = stepScale(
    ctx,
    'internal',
    prev.internal,
    cfg.swings.internal.L,
    cfg.swings.internal.R,
  );
  const external = stepScale(
    ctx,
    'external',
    prev.external,
    cfg.swings.external.L,
    cfg.swings.external.R,
  );

  const breaks: BreakInfo[] = [];
  for (const [scale, out] of [
    ['internal', internal],
    ['external', external],
  ] as const) {
    for (const ev of out.events) {
      if (/^(BOS|CHOCH)_(UP|DOWN)$/.test(ev.type)) {
        breaks.push({
          type: ev.type as BreakInfo['type'],
          scale,
          eventId: ev.id,
          legOriginIndex: out.state.protected?.barIndex ?? n,
        });
      }
    }
  }
  const zones = stepZones(ctx, prev.fvgs, prev.orderBlocks, breaks);

  const newSwings = [...internal.events, ...external.events]
    .filter((ev) => ev.type === 'SWING_HIGH' || ev.type === 'SWING_LOW')
    .map((ev) => {
      const st = ev.scale === 'internal' ? internal.state : external.state;
      return st.swings.find((s) => s.id === ev.id) as Swing;
    });
  const liquidity = stepLiquidity(ctx, prev.pools, prev.pending, prev.period, newSwings, [
    ...internal.state.swings,
    ...external.state.swings,
  ]);

  const tfState: TfState = {
    window: bars,
    base,
    atr,
    internal: internal.state,
    external: external.state,
    fvgs: zones.fvgs,
    orderBlocks: zones.orderBlocks,
    pools: liquidity.pools,
    pending: liquidity.pending,
    period: liquidity.period,
  };
  return {
    state: {
      ...state,
      perTf: { ...state.perTf, [tf]: tfState },
      lastCandleOpenTime: { ...state.lastCandleOpenTime, [tf]: candle.openTime },
    },
    events: [...internal.events, ...external.events, ...zones.events, ...liquidity.events],
  };
}
