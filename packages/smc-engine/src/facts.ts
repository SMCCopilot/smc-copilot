// ChartFacts: the only market view downstream consumers (including the AI) may see (A01 section 7).
// Built from engine state alone. Labels never contain prices; prices live in the numeric fields.
import {
  type MarketFacts,
  type StrategyConfig,
  TIMEFRAME_MS,
  type Timeframe,
} from '@smc/contracts';
import { shortId } from './ids.js';
import { biasAt } from './mtf.js';
import { dealingRange } from './ranges.js';
import type { EngineState, TfState } from './types.js';

export interface FactsOptions {
  /** Candle close time the facts are valid for (epoch ms). */
  asOf: number;
  dataQuality: MarketFacts['dataQuality'];
}

type Level = MarketFacts['levels'][number];
type Zone = MarketFacts['zones'][number];
type SetupFact = MarketFacts['setups'][number];

/** Locale-independent string order (localeCompare depends on the host ICU data). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const POOL_NAME: Record<string, string> = {
  EQH: 'Equal highs',
  EQL: 'Equal lows',
  PDH: 'Previous day high',
  PDL: 'Previous day low',
  PWH: 'Previous week high',
  PWL: 'Previous week low',
  SESH: 'Session high',
  SESL: 'Session low',
};

function levelsOf(tf: Timeframe, s: TfState, cfg: StrategyConfig): Level[] {
  const out: Level[] = [];
  for (const p of s.pools) {
    const name = p.label ? `${POOL_NAME[p.kind]} (${p.label})` : POOL_NAME[p.kind];
    out.push({
      id: shortId('L', p.id),
      label: `${name} ${tf}`,
      kind: p.kind,
      price: p.level,
    });
  }
  if (s.period.dayStart >= 0) {
    const opens: [string, string, number][] = [
      ['OPEN_D', 'Daily open', s.period.dayOpen],
      ['OPEN_W', 'Weekly open', s.period.weekOpen],
      ['OPEN_M', 'Monthly open', s.period.monthOpen],
    ];
    for (const [kind, name, price] of opens) {
      out.push({
        id: shortId('L', `${kind}|${tf}|${s.period.dayStart}`),
        label: `${name} ${tf}`,
        kind,
        price,
      });
    }
  }
  for (const scale of ['external'] as const) {
    const r = dealingRange(s[scale], cfg);
    if (!r) continue;
    const key = `${tf}|${scale}|${r.trend}`;
    out.push({
      id: shortId('L', `RL|${key}`),
      label: `Range low ${tf}`,
      kind: 'RANGE_LOW',
      price: r.low,
    });
    out.push({
      id: shortId('L', `RH|${key}`),
      label: `Range high ${tf}`,
      kind: 'RANGE_HIGH',
      price: r.high,
    });
    out.push({
      id: shortId('L', `RE|${key}`),
      label: `Range equilibrium ${tf}`,
      kind: 'RANGE_EQ',
      price: r.eq,
    });
  }
  return out;
}

function zonesOf(tf: Timeframe, s: TfState): Zone[] {
  const out: Zone[] = [];
  for (const f of s.fvgs) {
    if (f.status === 'FILLED') continue;
    out.push({
      id: shortId('Z', f.id),
      label: `${f.dir === 'BULL' ? 'Bullish' : 'Bearish'} FVG ${tf}`,
      top: f.top,
      bottom: f.bottom,
      state: f.status,
    });
  }
  for (const o of s.orderBlocks) {
    out.push({
      id: shortId('Z', o.id),
      label: `${o.dir === 'BULL' ? 'Bullish' : 'Bearish'} order block ${tf}`,
      top: o.top,
      bottom: o.bottom,
      state: o.status,
    });
  }
  return out;
}

export function buildFacts(
  state: EngineState,
  cfg: StrategyConfig,
  opts: FactsOptions,
): MarketFacts {
  const newest = Object.entries(state.lastCandleOpenTime).reduce(
    (m, [tf, open]) => Math.max(m, (open as number) + TIMEFRAME_MS[tf as Timeframe]),
    0,
  );
  if (opts.asOf < newest) {
    throw new Error('asOf is before the newest candle the engine has processed');
  }
  const levels: Level[] = [];
  const zones: Zone[] = [];
  const warnings: string[] = [];
  const tfs = (Object.keys(state.perTf) as Timeframe[]).sort(
    (a, b) => TIMEFRAME_MS[b] - TIMEFRAME_MS[a],
  );
  for (const tf of tfs) {
    const s = state.perTf[tf] as TfState;
    levels.push(...levelsOf(tf, s, cfg));
    zones.push(...zonesOf(tf, s));
    if (s.atr.count < cfg.atr.period && !warnings.includes('ATR_NOT_READY')) {
      warnings.push('ATR_NOT_READY');
    }
  }
  levels.sort((a, b) => cmp(a.kind, b.kind) || a.price - b.price || cmp(a.id, b.id));
  zones.sort((a, b) => cmp(a.label, b.label) || a.top - b.top || cmp(a.id, b.id));

  // Live setups (ARMED / TRIGGERED). Every id a setup mentions must resolve to a level or zone in the same facts.
  const levelIds = new Set(levels.map((l) => l.id));
  const zoneIds = new Set(zones.map((z) => z.id));
  const setupFacts: SetupFact[] = [];
  const live = [...state.setups].sort((a, b) => b.createdAt - a.createdAt || cmp(a.key, b.key));
  for (const s of live.slice(0, 50)) {
    const invId = shortId('L', `${s.key}|inv`);
    if (!levelIds.has(invId)) {
      levels.push({
        id: invId,
        label: `Invalidation ${s.entryTf}`,
        kind: 'INVALIDATION',
        price: s.invalidation,
      });
      levelIds.add(invId);
    }
    for (const t of s.targets) {
      if (!levelIds.has(t.levelId)) {
        levels.push({
          id: t.levelId,
          label: `Target ${t.label} ${s.entryTf}`,
          kind: 'TARGET',
          price: t.price,
        });
        levelIds.add(t.levelId);
      }
    }
    const poiId = shortId('Z', s.poi.zoneId);
    if (!zoneIds.has(poiId)) {
      zones.push({
        id: poiId,
        label: `${s.poi.kind === 'OB' ? 'Order block' : 'FVG'} point of interest ${s.entryTf}`,
        top: s.poi.top,
        bottom: s.poi.bottom,
        state: 'POI',
      });
      zoneIds.add(poiId);
    }
    setupFacts.push({
      id: shortId('S', s.key),
      template: s.template,
      direction: s.direction,
      grade: s.grade,
      state: s.state,
      reasonCodes: [],
      poi: poiId,
      invalidation: invId,
      targets: s.targets.map((t) => t.levelId),
      stats: null,
    });
  }

  const bias = biasAt(state, cfg, opts.asOf);
  const biasTf =
    [...cfg.timeframes.bias].sort((a, b) => TIMEFRAME_MS[b] - TIMEFRAME_MS[a])[0] ??
    cfg.timeframes.analysis[0] ??
    '1d';
  if (bias.perTf.some((p) => p.trend === 'NONE' || p.trend === 'UNDEFINED')) {
    warnings.push('NO_HTF_BIAS');
  }
  const lb = state.perTf[biasTf]?.external.lastBreak ?? null;

  return {
    asOf: opts.asOf,
    instrumentId: state.instrumentId,
    strategyVersionId: cfg.strategyVersionId,
    dataQuality: opts.dataQuality,
    htfBias: {
      tf: biasTf,
      trend: bias.trend,
      lastBreak: lb ? { id: shortId('E', lb.id), type: lb.type } : null,
    },
    levels: levels.slice(0, 400),
    zones: zones.slice(0, 400),
    setups: setupFacts,
    warnings,
  };
}
