import type { LineTone, Overlay, ZoneTone } from './overlays';

/**
 * How each kind of overlay looks. Colour is never the only signal: every item also has a text label, a glyph
 * and a line pattern. Green and red are used only for price direction (premium/discount, targets, stop).
 */
export interface Palette {
  accent: string;
  bull: string;
  bear: string;
  warn: string;
  muted: string;
  text: string;
}
export const OB_VIOLET = '#A78BFA';

export function withAlpha(hex: string, alpha: number): string {
  const h = hex.trim().replace('#', '');
  if (h.length !== 6) return hex;
  const n = Number.parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export interface ZoneStyle {
  fill: string;
  stroke: string | null;
  glyph: string;
}
export interface LineStyle {
  color: string;
  dash: number[];
  width: number;
  glyph: string;
}

export function zoneStyle(tone: ZoneTone, c: Palette): ZoneStyle {
  switch (tone) {
    case 'fvg':
      return { fill: withAlpha(c.accent, 0.14), stroke: withAlpha(c.accent, 0.6), glyph: '◫' };
    case 'ob':
      return { fill: withAlpha(OB_VIOLET, 0.16), stroke: withAlpha(OB_VIOLET, 0.7), glyph: '▣' };
    case 'premium':
      return { fill: withAlpha(c.bear, 0.08), stroke: null, glyph: '▲' };
    case 'discount':
      return { fill: withAlpha(c.bull, 0.08), stroke: null, glyph: '▼' };
    case 'ote':
      return { fill: withAlpha(c.accent, 0.12), stroke: null, glyph: '◎' };
    case 'entry':
      return { fill: withAlpha(c.accent, 0.22), stroke: c.accent, glyph: '→' };
  }
}

export function lineStyle(tone: LineTone, c: Palette, up?: boolean): LineStyle {
  switch (tone) {
    case 'liquidity':
      return { color: c.warn, dash: [6, 4], width: 1, glyph: '≈' };
    case 'range':
      return { color: c.muted, dash: [1, 3], width: 1, glyph: '·' };
    case 'open':
      return { color: c.muted, dash: [2, 4], width: 1, glyph: '○' };
    case 'invalidation':
      return { color: c.bear, dash: [], width: 2, glyph: '✕' };
    case 'stop':
      return { color: c.bear, dash: [4, 3], width: 1, glyph: '⊘' };
    case 'target':
      return { color: up ? c.bull : c.bear, dash: [8, 3], width: 1.5, glyph: '◎' };
    case 'entry':
      return { color: c.accent, dash: [], width: 1, glyph: '→' };
  }
}

export const labelOf = (o: Overlay, glyph: string, price: string): string =>
  o.kind === 'zone' ? `${glyph} ${o.label}` : `${glyph} ${o.label} ${price}`;

export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    accent: v('--accent'),
    bull: v('--bull'),
    bear: v('--bear'),
    warn: v('--warn'),
    muted: v('--text-muted'),
    text: v('--text'),
  };
}
