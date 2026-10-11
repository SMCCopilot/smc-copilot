// Setup detection, hard filters, scoring and plans (A04 section 8), and the live setup lifecycle.
// A setup is created the bar AFTER its structure break, so the fair value gap that confirms the displacement
// is known (this is also when the A04 section 15.5 worked example creates its candidate).
import {
  CANDLE_FLAGS,
  type ReasonCode,
  type StrategyConfig,
  TIMEFRAME_MS,
  type Timeframe,
} from '@smc/contracts';
import { atrPercentile } from './atr.js';
import { round2, shortId } from './ids.js';
import { biasAt } from './mtf.js';
import { forceExpire, type Limits, resolveStep, type ShadowOutcome } from './outcomes.js';
import { buildPlan, collectTargets, pickTargets, planHashOf } from './planner.js';
import { dealingRange, premiumDiscount } from './ranges.js';
import { eventId } from './scale.js';
import {
  displacementFeature,
  type FeatureValues,
  freshnessFeature,
  rrFeature,
  scoreSetup,
  targetClarityFeature,
  zoneSizeFeature,
} from './score.js';
import { isWeekend, sessionContext } from './sessions.js';
import { sha1 } from './sha1.js';
import type {
  BreakRecord,
  CandleLite,
  EngineEvent,
  EngineEventType,
  EngineState,
  EventData,
  Json,
  SetupRecord,
  SweepRecord,
  TfState,
} from './types.js';

export interface StepOptions {
  /** Instrument tick size (price increment): the one-tick adverse slippage of the fill model. */
  tickSize?: number;
  /** Assumed spread in price units; defaults to risk.assumedSpreadBps of the entry price. */
  spread?: number;
  /** Feed health from the runner. Anything but OK stops new setups (DATA_STALE). Omitted in replays: OK. */
  dataQuality?: 'OK' | 'DEGRADED' | 'STALE';
}

const MAX_SETUPS = 100;
const SUSPECT_MASK = CANDLE_FLAGS.SPIKE_SUSPECT | CANDLE_FLAGS.CROSSCHECK_DIVERGENCE;

export function flagAt(bars: readonly CandleLite[], t: number): number {
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i] as CandleLite;
    if (b.t === t) return b.f ?? 0;
    if (b.t < t) break;
  }
  return 0;
}

const isLongBreak = (type: BreakRecord['type']): boolean => type.endsWith('UP');

export interface SetupStepResult {
  setups: SetupRecord[];
  events: EngineEvent[];
  /** The break records with `done` set for every break decided (or too old to decide) on this candle. */
  breaks: BreakRecord[];
}

export function stepSetups(
  state: EngineState,
  tf: Timeframe,
  cfg: StrategyConfig,
  opts: StepOptions,
  thisEvents: readonly EngineEvent[],
  closeTime: number,
): SetupStepResult {
  const tfs = state.perTf[tf] as TfState;
  const bars = tfs.window;
  const bar = bars[bars.length - 1] as CandleLite;
  const n = tfs.base + bars.length - 1;
  const tfMs = TIMEFRAME_MS[tf];
  const events: EngineEvent[] = [];
  const idCtx = { instrumentId: state.instrumentId, tf, cfg };
  const emit = (type: EngineEventType, setupKey: string, data: EventData): void => {
    events.push({
      id: eventId(idCtx, type, null, bar.t, `|${setupKey}`),
      type,
      tf,
      scale: null,
      time: closeTime,
      anchorOpenTime: bar.t,
      data,
    });
  };

  // ---- 1. Advance the live setups of this timeframe.
  const expiryBars = cfg.setups.expiryBars[tf] ?? 64;
  const limits: Limits = {
    expiryBars,
    resolveBars: Math.max(1, Math.round(expiryBars * cfg.setups.resolveBarsMult)),
  };
  const breakDirs = new Set<string>();
  for (const e of thisEvents) {
    if (e.tf === tf && e.scale === 'internal' && /^(BOS|CHOCH)_(UP|DOWN)$/.test(e.type)) {
      breakDirs.add(e.type.endsWith('UP') ? 'LONG' : 'SHORT');
    }
  }
  const next: SetupRecord[] = [];
  for (const s of state.setups) {
    if (s.entryTf !== tf) {
      next.push(s);
      continue;
    }
    const r = resolveStep(s, bar, n, closeTime, limits, breakDirs.has(s.direction));
    for (const t of r.transitions) {
      const type: EngineEventType =
        t.to === 'TRIGGERED'
          ? 'SETUP_TRIGGERED'
          : t.to === 'EXPIRED'
            ? 'SETUP_EXPIRED'
            : 'SETUP_INVALIDATED';
      emit(type, s.key, { setupKey: s.key, reasonCodes: t.reasons });
    }
    if (r.outcome) emit('SETUP_RESOLVED', s.key, outcomeData(s.key, r.outcome));
    if (r.setup) next.push(r.setup);
  }

  // ---- 2. New setups from breaks that closed on the previous bar.
  const enabled = cfg.setups.enabled;
  const atrReady = cfg.atr.fixed !== undefined || tfs.atr.count >= cfg.atr.period;
  const breaks: BreakRecord[] = [];
  for (const brk of tfs.breaks) {
    // Decide every pending break the first time a later candle closes, so a missing candle delays a setup
    // instead of silently dropping it. A break older than three bars is skipped on purpose.
    if (brk.done || brk.time >= closeTime || !cfg.timeframes.entry.includes(tf)) {
      breaks.push(brk);
      continue;
    }
    breaks.push({ ...brk, done: true });
    if (!atrReady || closeTime - brk.time > 3 * tfMs) continue;
    const template = brk.type.startsWith('BOS') ? 'T2' : 'T1';
    if (!enabled.includes(template)) continue;
    const built = evaluate(state, tf, cfg, opts, tfs, bars, n, closeTime, brk, template, emit);
    if (built && !next.some((x) => x.key === built.key)) next.push(built);
  }
  // Over the cap the oldest setup is expired with an outcome, never dropped without a trace.
  while (next.length > MAX_SETUPS) {
    const gone = next.shift() as SetupRecord;
    const f = forceExpire(gone, n, closeTime);
    emit('SETUP_EXPIRED', gone.key, { setupKey: gone.key, reasonCodes: f.transition.reasons });
    emit('SETUP_RESOLVED', gone.key, outcomeData(gone.key, f.outcome));
  }
  return { setups: next, events, breaks };
}

function outcomeData(setupKey: string, o: ShadowOutcome): EventData {
  return {
    setupKey,
    outcome: o.outcome,
    filled: o.filled,
    fillTime: o.fillTime,
    fillPrice: o.fillPrice,
    resolutionTime: o.resolutionTime,
    rTp1: o.rTp1,
    feesR: o.feesR,
    realizedR: o.realizedR,
    mfeR: o.mfeR,
    maeR: o.maeR,
    barsToResolution: o.barsToResolution,
    ambiguousIntrabar: o.ambiguousIntrabar,
    rulesVersion: o.rulesVersion,
  };
}

type Emit = (type: EngineEventType, setupKey: string, data: EventData) => void;

/** Builds one candidate; emits its events; returns the live record when it is armed. */
function evaluate(
  state: EngineState,
  tf: Timeframe,
  cfg: StrategyConfig,
  opts: StepOptions,
  tfs: TfState,
  bars: readonly CandleLite[],
  n: number,
  closeTime: number,
  brk: BreakRecord,
  template: 'T1' | 'T2',
  emit: Emit,
): SetupRecord | null {
  const tfMs = TIMEFRAME_MS[tf];
  const long = isLongBreak(brk.type);
  const dir = long ? 'BULL' : 'BEAR';
  const key = sha1(
    `${state.instrumentId}|${tf}|${template}|${long ? 'L' : 'S'}|${brk.eventId}|${cfg.strategyVersionId}`,
  );
  const atr = tfs.atr.value;
  const bias = biasAt(state, cfg, closeTime);
  const biasTf =
    [...cfg.timeframes.bias].sort((a, b) => TIMEFRAME_MS[b] - TIMEFRAME_MS[a])[0] ?? tf;

  // Components.
  const ob = tfs.orderBlocks.find((o) => o.breakEventId === brk.eventId && o.dir === dir);
  let fvg = undefined as TfState['fvgs'][number] | undefined;
  for (let i = tfs.fvgs.length - 1; i >= 0; i--) {
    const f = tfs.fvgs[i] as TfState['fvgs'][number];
    if (f.dir === dir && f.barIndex > brk.legOriginIndex) {
      fvg = f;
      break;
    }
  }
  type Poi = {
    zoneId: string;
    kind: 'OB' | 'FVG';
    top: number;
    bottom: number;
    ref: number;
    status: string;
    touches: number;
    candleOpens: number[];
  };
  const poi: Poi | null = ob
    ? {
        zoneId: ob.id,
        kind: 'OB',
        top: ob.top,
        bottom: ob.bottom,
        ref: (ob.top + ob.bottom) / 2,
        status: ob.status,
        touches: ob.touches,
        candleOpens: [ob.barOpen],
      }
    : fvg
      ? {
          zoneId: fvg.id,
          kind: 'FVG',
          top: fvg.top,
          bottom: fvg.bottom,
          ref: fvg.ce,
          status: fvg.status,
          touches: 0,
          candleOpens: [fvg.createdAt - 3 * tfMs, fvg.createdAt - 2 * tfMs, fvg.createdAt - tfMs],
        }
      : null;

  let sweep: SweepRecord | undefined;
  for (let i = tfs.sweeps.length - 1; i >= 0; i--) {
    const sw = tfs.sweeps[i] as SweepRecord;
    if (
      sw.side === (long ? 'SELL' : 'BUY') &&
      sw.confirmedAt <= brk.time &&
      sw.wickOpenTime >= brk.breakOpenTime - cfg.setups.sweepLookbackBars * tfMs
    ) {
      sweep = sw;
      break;
    }
  }
  // T1 is defined by the sweep; without one this break is simply not a T1.
  if (template === 'T1' && !sweep) return null;

  const range = dealingRange(tfs.internal, cfg);
  const components: Json = [
    { kind: brk.type.startsWith('BOS') ? 'BOS' : 'CHOCH', id: shortId('E', brk.eventId) },
    ...(sweep
      ? [
          { kind: 'SWEEP', id: shortId('E', sweep.eventId) },
          { kind: 'POOL', id: shortId('L', sweep.poolId) },
        ]
      : []),
    ...(poi ? [{ kind: poi.kind, id: shortId('Z', poi.zoneId) }] : []),
    ...(fvg && poi?.kind === 'OB' ? [{ kind: 'FVG', id: shortId('Z', fvg.id) }] : []),
    ...(range
      ? [{ kind: 'RANGE', id: shortId('R', `${tf}|internal|${range.low}|${range.high}`) }]
      : []),
  ];
  const baseLevel =
    template === 'T1' && sweep ? sweep.extreme : poi ? (long ? poi.bottom : poi.top) : 0;
  const basis = template === 'T1' ? 'SWEEP_EXTREME' : 'OB_FAR_EDGE';
  const summary = {
    setupKey: key,
    template,
    direction: long ? 'LONG' : 'SHORT',
    entryTf: tf,
    biasTf,
    components,
    poi: poi
      ? { zoneId: poi.zoneId, kind: poi.kind, top: poi.top, bottom: poi.bottom, ref: poi.ref }
      : null,
    invalidation: poi ? { level: baseLevel, basis } : null,
  };
  emit('SETUP_CANDIDATE', key, summary);

  // ---- hard filters (A04 section 8.3). Every failing code is recorded, not just the first.
  const reasons: ReasonCode[] = [];
  if (cfg.filters.requireDataOk && opts.dataQuality !== undefined && opts.dataQuality !== 'OK') {
    reasons.push('DATA_STALE');
  }
  if (!poi) {
    reasons.push('NO_POI');
    emit('SETUP_REJECTED', key, { ...summary, reasonCodes: reasons });
    return null;
  }
  const suspect =
    (poi.candleOpens.reduce((acc, t) => acc | flagAt(bars, t), flagAt(bars, brk.breakOpenTime)) |
      (sweep?.flags ?? 0)) &
    SUSPECT_MASK;
  if (suspect) reasons.push('DATA_SUSPECT');
  if (cfg.filters.requirePoiFresh && (poi.status === 'FILLED' || poi.status === 'INVERTED')) {
    reasons.push('POI_MITIGATED');
  }
  if (template === 'T2' && bias.trend === (long ? 'BEAR' : 'BULL'))
    reasons.push('HTF_COUNTER_BIAS');
  const pd = range ? premiumDiscount(poi.ref, range) : null;
  const enforcePd = template === 'T1' ? cfg.filters.enforcePdSideT1 : cfg.filters.enforcePdSideT2;
  if (enforcePd && pd && (long ? pd.zone === 'PREMIUM' : pd.zone === 'DISCOUNT')) {
    reasons.push('WRONG_PD_SIDE');
  }

  const buffer = cfg.risk.stopBufferAtrMult * atr;
  const spread = opts.spread ?? (poi.ref * cfg.risk.assumedSpreadBps) / 10_000;
  const tick = opts.tickSize ?? 0;
  const stop = long ? baseLevel - buffer - spread : baseLevel + buffer + spread;
  const risk = long ? poi.ref - stop : stop - poi.ref;
  const stopAtr = atr > 0 ? risk / atr : 0;
  if (!(risk > 0) || stopAtr < cfg.risk.minStopAtrMult) reasons.push('STOP_TOO_TIGHT');
  else if (stopAtr > cfg.risk.maxStopAtrMult) reasons.push('STOP_TOO_WIDE');

  const picked =
    risk > 0
      ? pickTargets(
          collectTargets(state, cfg, tf, poi.ref, long),
          poi.ref,
          risk,
          cfg.risk.minRR,
          long,
        )
      : { targets: [], anyLevel: false };
  // An unusable stop is already reported as STOP_TOO_TIGHT; it says nothing about targets.
  if (risk > 0) {
    if (!picked.anyLevel) reasons.push('NO_TARGET');
    else if (picked.targets.length === 0) reasons.push('RR_TOO_LOW');
  }

  if (spread > cfg.filters.maxSpreadAtrMult * atr) reasons.push('SPREAD_WIDE');
  if (
    tfs.atr.hist.length >= 50 &&
    atrPercentile(tfs.atr) >= cfg.filters.volExtremePercentile / 100
  ) {
    reasons.push('VOL_EXTREME');
  }

  if (reasons.length > 0) {
    emit('SETUP_REJECTED', key, { ...summary, reasonCodes: reasons });
    return null;
  }

  // ---- soft features, score, grade.
  const tp1 = picked.targets[0] as NonNullable<(typeof picked.targets)[number]>;
  const aligned = long ? 'BULL' : 'BEAR';
  const fvgFeature = ((): number => {
    if (poi.kind === 'FVG') return 1;
    if (!fvg) return 0;
    const overlap = Math.min(poi.top, fvg.top) - Math.max(poi.bottom, fvg.bottom);
    if (overlap > 0) return 1;
    return -overlap <= 0.25 * atr ? 0.5 : 0;
  })();
  const values: FeatureValues = {
    htfAlignment: bias.trend === aligned ? 1 : bias.trend === 'RANGE' ? 0.4 : 0,
    sweepPresent: sweep ? 1 : 0,
    displacementStrength: displacementFeature(brk.bodyAtr),
    fvgConfluence: fvgFeature,
    obFreshness: freshnessFeature(poi.status, poi.touches),
    killzone: sessionContext(closeTime, cfg).inKillzone ? 1 : 0,
    rrQuality: rrFeature(tp1.rr),
    zoneSize: zoneSizeFeature(atr > 0 ? (poi.top - poi.bottom) / atr : 3),
    targetClarity: targetClarityFeature(atr > 0 ? Math.abs(tp1.price - poi.ref) / atr : 0),
    gapBreakPenalty: brk.gapBreak ? 1 : 0,
    weekendLiquidity: isWeekend(closeTime) ? 1 : 0,
  };
  const scored = scoreSetup(values, cfg);

  // ---- plan.
  const against = collectTargets(state, cfg, tf, baseLevel, !long)[0];
  const plan = buildPlan({
    setupKey: key,
    strategyVersionId: cfg.strategyVersionId,
    template,
    long,
    poi,
    stop,
    stopBasis: basis,
    bufferAtr: cfg.risk.stopBufferAtrMult,
    invalidation: {
      level: baseLevel,
      rule: long ? 'CLOSE_BELOW_LEVEL_VOIDS_THESIS' : 'CLOSE_ABOVE_LEVEL_VOIDS_THESIS',
    },
    invalidationLevelId: shortId('L', `${key}|inv`),
    targets: picked.targets,
    nextAgainst: against ? { levelId: against.levelId, price: against.price } : null,
    spread,
    slippage: tick,
    feeBps: cfg.risk.takerFeeBps,
  });
  const planHash = planHashOf({ long, poi, stop, targets: picked.targets });

  emit('SETUP_ARMED', key, {
    ...summary,
    grade: scored.grade,
    score: scored.score,
    features: scored.contributions,
    reasonCodes: [],
    biasTrend: bias.trend,
    premiumDiscount: pd ? { zone: pd.zone, pct: round2(pd.pct) } : null,
  });
  emit('PLAN_READY', key, { setupKey: key, planHash, plan: plan as unknown as Json });

  return {
    key,
    template,
    direction: long ? 'LONG' : 'SHORT',
    entryTf: tf,
    biasTf,
    state: 'ARMED',
    grade: scored.grade,
    score: scored.score,
    createdAt: closeTime,
    createdIndex: n,
    poi: { zoneId: poi.zoneId, kind: poi.kind, top: poi.top, bottom: poi.bottom, ref: poi.ref },
    stop,
    invalidation: baseLevel,
    targets: picked.targets,
    slippage: tick,
    halfSpread: spread / 2,
    feeBps: cfg.risk.takerFeeBps,
    touched: false,
    fill: null,
    hi: 0,
    lo: 0,
    ambiguous: false,
    planHash,
  };
}
