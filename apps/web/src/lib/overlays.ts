import type { AnalysisResponse } from '@smc/contracts';

/**
 * Pure mapping from the API's analysis snapshot to things to draw. No SMC logic lives here: every price,
 * zone and level comes from the API; this only decides which layer an item belongs to and how it is labelled.
 */
export const LAYERS = ['structure', 'fvg', 'ob', 'liquidity', 'ranges', 'sessions'] as const;
export type LayerId = (typeof LAYERS)[number];
export const LAYER_LABEL: Record<LayerId, string> = {
  structure: 'Structure',
  fvg: 'FVG',
  ob: 'Order blocks',
  liquidity: 'Liquidity',
  ranges: 'Ranges',
  sessions: 'Session levels',
};
/** One line each, shown on hover, so no label needs prior knowledge. */
export const LAYER_HINT: Record<LayerId, string> = {
  structure: 'Breaks of structure (BOS, CHoCH) and the main swing highs and lows',
  fvg: 'Fair value gaps: price gaps left by a fast move, which price often returns to',
  ob: 'Order blocks: the last opposite candle before a strong move',
  liquidity:
    'Liquidity: equal highs and lows and previous day and week highs and lows, where stops sit',
  ranges: 'The current range with its midpoint, premium and discount halves',
  sessions: 'Daily, weekly and monthly opens and session highs and lows',
};
export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  structure: true,
  fvg: true,
  ob: true,
  liquidity: true,
  ranges: true,
  sessions: false,
};

export type ZoneTone = 'fvg' | 'ob' | 'premium' | 'discount' | 'ote' | 'entry';
export type LineTone =
  | 'liquidity'
  | 'range'
  | 'open'
  | 'invalidation'
  | 'stop'
  | 'target'
  | 'entry';

export type Overlay =
  | {
      kind: 'zone';
      layer: LayerId | 'plan';
      id: string;
      label: string;
      top: number;
      bottom: number;
      tone: ZoneTone;
      /** When it formed (ISO). A zone with a time starts at that candle; without one it spans the chart. */
      from?: string;
    }
  | {
      kind: 'line';
      layer: LayerId | 'plan';
      id: string;
      label: string;
      price: number;
      tone: LineTone;
      from?: string;
      /** Price direction for targets: above the entry is up (green), below is down (red). */
      up?: boolean;
    };

const SESSION_KINDS = new Set(['SESH', 'SESL']);
const RANGE_KINDS = new Set(['RANGE_LOW', 'RANGE_HIGH', 'RANGE_EQ']);

export function zoneLayer(label: string): 'fvg' | 'ob' {
  return /order block/i.test(label) ? 'ob' : 'fvg';
}

export function levelLayer(kind: string): LayerId | null {
  if (kind === 'INVALIDATION' || kind === 'TARGET') return null; // drawn from the plan instead
  if (RANGE_KINDS.has(kind)) return 'ranges';
  if (SESSION_KINDS.has(kind) || kind.startsWith('OPEN_')) return 'sessions';
  return 'liquidity'; // known pools and anything new the engine adds
}

type Setup = NonNullable<AnalysisResponse['setups']>[number];

export function buildOverlays(a: AnalysisResponse, setup: Setup | null): Overlay[] {
  const out: Overlay[] = [];
  for (const z of a.zones ?? []) {
    const layer = zoneLayer(z.label);
    out.push({
      kind: 'zone',
      layer,
      id: z.id,
      label: z.label,
      top: z.top,
      bottom: z.bottom,
      tone: layer,
      ...(z.from ? { from: z.from } : {}),
    });
  }
  for (const l of [...(a.liquidity ?? []), ...(a.context?.openLevels ?? [])]) {
    const layer = levelLayer(l.kind);
    if (!layer) continue;
    out.push({
      kind: 'line',
      layer,
      id: l.id,
      label: l.label,
      price: l.price,
      tone: layer === 'ranges' ? 'range' : layer === 'sessions' ? 'open' : 'liquidity',
      ...(l.from ? { from: l.from } : {}),
    });
  }
  const r = a.structure?.range;
  if (r) {
    out.push(
      {
        kind: 'zone',
        layer: 'ranges',
        id: 'premium',
        label: 'Premium',
        top: r.high,
        bottom: r.eq,
        tone: 'premium',
      },
      {
        kind: 'zone',
        layer: 'ranges',
        id: 'discount',
        label: 'Discount',
        top: r.eq,
        bottom: r.low,
        tone: 'discount',
      },
      {
        kind: 'zone',
        layer: 'ranges',
        id: 'ote',
        label: 'OTE band',
        top: r.oteTop,
        bottom: r.oteBottom,
        tone: 'ote',
      },
    );
  }
  const p = setup?.plan;
  if (p) {
    out.push(
      {
        kind: 'zone',
        layer: 'plan',
        id: 'entry',
        label: 'Entry zone',
        top: p.entry.top,
        bottom: p.entry.bottom,
        tone: 'entry',
      },
      { kind: 'line', layer: 'plan', id: 'stop', label: 'Stop', price: p.stop.price, tone: 'stop' },
      {
        kind: 'line',
        layer: 'plan',
        id: 'invalidation',
        label: 'Invalidation',
        price: p.invalidation.level,
        tone: 'invalidation',
      },
    );
    for (const t of p.targets) {
      out.push({
        kind: 'line',
        layer: 'plan',
        id: t.id,
        label: t.label,
        price: t.price,
        tone: 'target',
        up: t.price > p.entry.refPrice,
      });
    }
  }
  return out;
}

export function visible(items: Overlay[], on: Record<LayerId, boolean>): Overlay[] {
  return items.filter((o) => o.layer === 'plan' || on[o.layer]);
}

const TF_MINUTES: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
};

/**
 * A chart should not carry levels from timeframes below its own: on a daily chart, fifteen-minute gaps are noise a few
 * dollars wide. Levels whose label names a lower timeframe are dropped; ones with no timeframe in the label stay.
 */
export function relevantForTf(items: Overlay[], chartTf: string): Overlay[] {
  const mine = TF_MINUTES[chartTf];
  if (mine === undefined) return items;
  return items.filter((o) => {
    if (o.layer === 'plan') return true;
    const m = /\b(1m|3m|5m|15m|30m|1h|2h|4h|1d|1w)\b/i.exec(o.label);
    const theirs = m?.[1] ? TF_MINUTES[m[1].toLowerCase()] : undefined;
    return theirs === undefined || theirs >= mine;
  });
}

const midOf = (o: Overlay): number => (o.kind === 'zone' ? (o.top + o.bottom) / 2 : o.price);

/**
 * Overlay-only view: on a wide timeframe the engine tracks dozens of levels spread over tens of thousands of dollars,
 * and drawing them all on one ruler is unreadable. Keep the plan lines (always) plus the levels nearest the price,
 * and say how many were left out. The reference price is the plan's entry when there is one, else the median level
 * (levels cluster around the market).
 */
export function focusOverlays(
  items: Overlay[],
  max = 14,
  /** The real price when there are candles; else the plan's entry or the median level is used. */
  price?: number,
): { shown: Overlay[]; hidden: number } {
  if (items.length <= max) return { shown: items, hidden: 0 };
  const plan = items.filter((o) => o.layer === 'plan');
  const entry = plan.find((o) => o.kind === 'zone');
  const mids = items.map(midOf).sort((a, b) => a - b);
  const ref = price ?? (entry ? midOf(entry) : (mids[Math.floor(mids.length / 2)] as number));
  const rest = items
    .filter((o) => o.layer !== 'plan')
    .sort((a, b) => Math.abs(midOf(a) - ref) - Math.abs(midOf(b) - ref));
  const shown = [...plan, ...rest.slice(0, Math.max(0, max - plan.length))];
  return { shown, hidden: items.length - shown.length };
}

/** Moves label positions (percent from the top) apart so none sit closer than `gap`, keeping the order. */
export function stackLabels(positions: number[], gap: number): number[] {
  const order = positions.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array<number>(positions.length);
  let floor = Number.NEGATIVE_INFINITY;
  for (const o of order) {
    const y = Math.max(o.p, floor);
    out[o.i] = y;
    floor = y + gap;
  }
  const over = Math.max(...out) - 100;
  if (over > 0) {
    // Shift the whole stack up, then re-spread from the top if that pushed the first one off the screen.
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) - over;
  }
  return out;
}

export const overlayPrices = (items: Overlay[]): number[] =>
  items.flatMap((o) => (o.kind === 'zone' ? [o.top, o.bottom] : [o.price]));

export interface StructureMark {
  time: string;
  label: string;
  kind: 'HIGH' | 'LOW' | 'BREAK';
  scale: 'internal' | 'external';
  price?: number;
}

export function structureMarks(a: AnalysisResponse): StructureMark[] {
  const s = a.structure;
  if (!s) return [];
  return [
    ...s.swings.map((w) => ({
      time: w.time,
      label: w.kind === 'HIGH' ? 'Swing high' : 'Swing low',
      kind: w.kind,
      scale: w.scale,
      price: w.price,
    })),
    ...s.breaks.map((b) => ({
      time: b.time,
      label: b.type.replaceAll('_', ' '),
      kind: 'BREAK' as const,
      scale: b.scale,
    })),
  ].sort((x, y) => x.time.localeCompare(y.time));
}

export function formatPrice(price: number, precision = 2): string {
  return price.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** The open time (seconds) of the last candle that opened at or before `t`; null when `t` is before the first one. */
export function snapToBar(bars: readonly number[], t: number): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid] as number) <= t) {
      found = bars[mid] as number;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
