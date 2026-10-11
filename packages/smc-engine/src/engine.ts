import { type Candle, type StrategyConfig, TIMEFRAME_MS } from '@smc/contracts';
import { emptyAtr, updateAtr } from './atr.js';
import { emptyPeriod, stepLiquidity } from './liquidity.js';
import { MAX_SNAPSHOTS, orderByClose, snapshotOf } from './mtf.js';
import { emptyScale, stepScale } from './scale.js';
import { flagAt, type StepOptions, stepSetups } from './setups.js';
import type {
  BreakRecord,
  CandleLite,
  EngineEvent,
  EngineState,
  SweepRecord,
  Swing,
  TfState,
} from './types.js';
import { type BreakInfo, stepZones } from './zones.js';

export const WINDOW_BARS = 600;
/** Bump whenever EngineState changes shape or a rule changes what state means. */
export const STATE_VERSION = 3;

export function createEngine(instrumentId: string): EngineState {
  return { v: STATE_VERSION, instrumentId, perTf: {}, lastCandleOpenTime: {}, mtf: {}, setups: [] };
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
  sweeps: [],
  breaks: [],
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
  opts: StepOptions = {},
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
    ...(candle.flags ? { f: candle.flags } : {}),
  };
  const grown = [...prev.window, bar];
  const drop = Math.max(0, grown.length - WINDOW_BARS);
  const bars = drop > 0 ? grown.slice(drop) : grown;
  const base = prev.base + drop;
  const n = base + bars.length - 1;
  const closeTimeMs = candle.openTime + TIMEFRAME_MS[tf];
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

  const sweeps: SweepRecord[] = [...prev.sweeps];
  for (const ev of liquidity.events) {
    if (ev.type !== 'LIQ_SWEEP') continue;
    const wick = ev.data.wickOpenTime as number;
    sweeps.push({
      poolId: ev.data.poolId as string,
      poolKind: ev.data.poolKind as SweepRecord['poolKind'],
      side: ev.data.side as 'BUY' | 'SELL',
      level: ev.data.level as number,
      extreme: ev.data.sweepExtreme as number,
      wickOpenTime: wick,
      confirmedAt: closeTimeMs,
      eventId: ev.id,
      flags: flagAt(bars, wick),
    });
  }
  const recentBreaks: BreakRecord[] = [...prev.breaks];
  for (const ev of internal.events) {
    if (/^(BOS|CHOCH)_(UP|DOWN)$/.test(ev.type)) {
      recentBreaks.push({
        eventId: ev.id,
        type: ev.type as BreakRecord['type'],
        time: closeTimeMs,
        breakOpenTime: candle.openTime,
        legOriginIndex: internal.state.protected?.barIndex ?? n,
        bodyAtr: ev.data.bodyAtr as number,
        gapBreak: ev.data.gapBreak === true,
      });
    }
  }

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
    sweeps: sweeps.slice(-20),
    breaks: recentBreaks.slice(-6),
  };
  const mtf = cfg.timeframes.bias.includes(tf)
    ? {
        ...state.mtf,
        [tf]: [...(state.mtf[tf] ?? []), snapshotOf(closeTimeMs, external.state, cfg)].slice(
          -MAX_SNAPSHOTS,
        ),
      }
    : state.mtf;
  const stepEvents = [...internal.events, ...external.events, ...zones.events, ...liquidity.events];
  const interim: EngineState = {
    ...state,
    mtf,
    perTf: { ...state.perTf, [tf]: tfState },
    lastCandleOpenTime: { ...state.lastCandleOpenTime, [tf]: candle.openTime },
  };
  if (!cfg.timeframes.entry.includes(tf)) return { state: interim, events: stepEvents };
  const setups = stepSetups(interim, tf, cfg, opts, stepEvents, closeTimeMs);
  return {
    state: { ...interim, setups: setups.setups },
    events: [...stepEvents, ...setups.events],
  };
}

/** Feed candles in canonical close order (higher timeframe first on equal close time). */
export function feed(
  state: EngineState,
  candles: readonly Candle[],
  cfg: StrategyConfig,
  opts: StepOptions = {},
): { state: EngineState; events: EngineEvent[] } {
  let current = state;
  const events: EngineEvent[] = [];
  for (const c of orderByClose(candles)) {
    const r = step(current, c, cfg, opts);
    current = r.state;
    events.push(...r.events);
  }
  return { state: current, events };
}
