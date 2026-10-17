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
  sessions: 'Sessions',
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
    }
  | {
      kind: 'line';
      layer: LayerId | 'plan';
      id: string;
      label: string;
      price: number;
      tone: LineTone;
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
