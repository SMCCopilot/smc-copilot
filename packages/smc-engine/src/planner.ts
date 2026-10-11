// Targets and trade plan (A04 section 10.2). Targets are levels from the engine's own pools and unswept swings,
// never arbitrary R multiples: RR is derived from the levels.
import {
  type ScenarioFact,
  type StrategyConfig,
  TIMEFRAME_MS,
  type Timeframe,
  type TradePlan,
} from '@smc/contracts';
import { shortId } from './ids.js';
import { sha1 } from './sha1.js';
import type { CandleLite, EngineState, PlanTargetRecord, Swing, TfState } from './types.js';

export interface TargetCandidate {
  levelId: string;
  price: number;
  /** From a bias timeframe (HTF liquidity). */
  htf: boolean;
}

/** A swing still counts as a target while no later candle has traded through it (a wick sweeps it). */
function unswept(s: Swing, tf: TfState): boolean {
  for (let i = s.barIndex + 1; i < tf.base + tf.window.length; i++) {
    const b = tf.window[i - tf.base] as CandleLite | undefined;
    if (b && (s.kind === 'HIGH' ? b.h >= s.level : b.l <= s.level)) return false;
  }
  return true;
}

/**
 * Levels on the profit side of `ref` from pools and unswept swings of every analysed timeframe at least as
 * high as the entry timeframe, nearest first.
 */
export function collectTargets(
  state: EngineState,
  cfg: StrategyConfig,
  entryTf: Timeframe,
  ref: number,
  long: boolean,
): TargetCandidate[] {
  const out = new Map<string, TargetCandidate>();
  // A level the current candle has already traded through is not a target: it is gone before the plan exists.
  const cur = state.perTf[entryTf]?.window.at(-1);
  const reached = (level: number): boolean =>
    cur !== undefined && (long ? level <= cur.h : level >= cur.l);
  const beyond = (level: number): boolean => (long ? level > ref : level < ref) && !reached(level);
  for (const tf of cfg.timeframes.analysis) {
    const s = state.perTf[tf];
    if (!s || TIMEFRAME_MS[tf] < TIMEFRAME_MS[entryTf]) continue;
    const htf = cfg.timeframes.bias.includes(tf);
    for (const p of s.pools) {
      if (beyond(p.level)) {
        const levelId = shortId('L', p.id);
        out.set(levelId, { levelId, price: p.level, htf });
      }
    }
    for (const scale of [s.internal, s.external]) {
      for (const sw of scale.swings) {
        if (sw.kind !== (long ? 'HIGH' : 'LOW') || !beyond(sw.level) || !unswept(sw, s)) continue;
        const levelId = shortId('L', sw.id);
        out.set(levelId, { levelId, price: sw.level, htf });
      }
    }
  }
  return [...out.values()].sort(
    (a, b) => (long ? a.price - b.price : b.price - a.price) || (a.levelId < b.levelId ? -1 : 1),
  );
}

export interface PickedTargets {
  targets: PlanTargetRecord[];
  /** At least one level exists beyond the entry (even if none reaches minRR). */
  anyLevel: boolean;
}

/** TP1: nearest level giving at least minRR. TP2: the next HTF level beyond TP1, else the next level of any kind. */
export function pickTargets(
  candidates: readonly TargetCandidate[],
  ref: number,
  riskDistance: number,
  minRR: number,
  long: boolean,
): PickedTargets {
  const rr = (price: number): number => Math.abs(price - ref) / riskDistance;
  const tp1 = candidates.find((c) => rr(c.price) >= minRR);
  if (!tp1) return { targets: [], anyLevel: candidates.length > 0 };
  const farther = candidates.filter((c) => (long ? c.price > tp1.price : c.price < tp1.price));
  const tp2 = farther.find((c) => c.htf) ?? farther[0];
  const targets: PlanTargetRecord[] = [
    { id: 'TP1', price: tp1.price, levelId: tp1.levelId, rr: rr(tp1.price), label: 'TP1' },
  ];
  if (tp2)
    targets.push({
      id: 'TP2',
      price: tp2.price,
      levelId: tp2.levelId,
      rr: rr(tp2.price),
      label: 'TP2',
    });
  return { targets, anyLevel: true };
}

export interface PlanInput {
  setupKey: string;
  strategyVersionId: string;
  template: 'T1' | 'T2';
  long: boolean;
  poi: { zoneId: string; kind: 'OB' | 'FVG'; top: number; bottom: number; ref: number };
  stop: number;
  stopBasis: string;
  bufferAtr: number;
  invalidation: { level: number; rule: string };
  invalidationLevelId: string;
  targets: PlanTargetRecord[];
  /** The next opposing-side level beyond the invalidation, for the alternate scenario. */
  nextAgainst: { levelId: string; price: number } | null;
  spread: number;
  slippage: number;
  feeBps: number;
}

/** Hash of what a gate token binds: entry, stop and targets (never stats, which can change under a plan). */
export const planHashOf = (p: {
  long: boolean;
  poi: { top: number; bottom: number; ref: number };
  stop: number;
  targets: readonly { price: number }[];
}): string =>
  sha1(
    JSON.stringify([
      p.long,
      p.poi.top,
      p.poi.bottom,
      p.poi.ref,
      p.stop,
      p.targets.map((t) => t.price),
    ]),
  );

export function buildPlan(i: PlanInput): TradePlan {
  const poiId = shortId('Z', i.poi.zoneId);
  const reversal = i.template === 'T1';
  const primary: ScenarioFact = {
    kind: reversal ? 'REVERSAL' : 'CONTINUATION',
    condition: {
      type: i.long ? 'CLOSE_ABOVE' : 'CLOSE_BELOW',
      level: i.long ? i.poi.top : i.poi.bottom,
      levelId: poiId,
    },
    next: null,
  };
  const alternate: ScenarioFact = {
    kind: reversal ? 'SWEEP_NOT_REVERSAL' : 'POI_FAILS',
    condition: {
      type: i.long ? 'CLOSE_BELOW' : 'CLOSE_ABOVE',
      level: i.long ? i.poi.bottom : i.poi.top,
      levelId: poiId,
    },
    next: i.nextAgainst,
  };
  return {
    planId: shortId('P', `${i.setupKey}|1`),
    setupId: shortId('S', i.setupKey),
    strategyVersionId: i.strategyVersionId,
    direction: i.long ? 'LONG' : 'SHORT',
    entry: {
      type: 'LIMIT_ZONE',
      top: i.poi.top,
      bottom: i.poi.bottom,
      refPrice: i.poi.ref,
      refBasis: i.poi.kind === 'OB' ? 'OB_50' : 'FVG_CE',
    },
    stop: { price: i.stop, basis: i.stopBasis, bufferAtr: i.bufferAtr },
    targets: i.targets.map((t) => ({
      id: t.id,
      price: t.price,
      levelId: t.levelId,
      rr: t.rr,
      label: t.label,
    })),
    scenarios: { primary, alternate },
    invalidation: i.invalidation,
    assumptions: {
      spread: i.spread,
      slippage: i.slippage,
      feeBps: i.feeBps,
      fillModel: 'TOUCH_PLUS_TICK',
    },
    stats: null,
    statsReason: 'INSUFFICIENT_HISTORY',
    confidence: 'LOW',
    disclaimers: ['NOT_ADVICE', 'HISTORICAL_NOT_FORECAST'],
  };
}
