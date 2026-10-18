import type { AnalysisResponse } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildOverlays,
  DEFAULT_LAYERS,
  focusOverlays,
  levelLayer,
  type Overlay,
  overlayPrices,
  relevantForTf,
  stackLabels,
  visible,
  zoneLayer,
} from './overlays';

const base = {
  snapshotId: 's',
  asOf: '2026-10-01T00:00:00Z',
  instrumentId: 'i',
  strategyVersionId: 'v',
  dataQuality: 'OK',
  warnings: [],
  htfBias: { tf: '4h', trend: 'BULL', lastBreak: null },
} as const;

const analysis = {
  ...base,
  zones: [
    { id: 'Z1', label: 'Bullish FVG 15m', top: 105, bottom: 104, state: 'OPEN' },
    { id: 'Z2', label: 'Bearish order block 15m', top: 110, bottom: 109, state: 'OPEN' },
  ],
  liquidity: [
    { id: 'L1', label: 'Equal highs 15m', kind: 'EQH', price: 112 },
    { id: 'L2', label: 'Range low 15m', kind: 'RANGE_LOW', price: 100 },
    { id: 'L3', label: 'Invalidation 15m', kind: 'INVALIDATION', price: 99 },
    { id: 'L4', label: 'Session high', kind: 'SESH', price: 111 },
  ],
  structure: {
    tf: '15m',
    trend: 'BULL',
    internalTrend: 'BULL',
    swings: [],
    breaks: [],
    range: { low: 100, high: 120, eq: 110, oteBottom: 105, oteTop: 107, trend: 'BULL' },
  },
} as unknown as AnalysisResponse;

describe('overlay mapping', () => {
  it('classifies zones and levels into layers', () => {
    expect(zoneLayer('Bullish FVG 15m')).toBe('fvg');
    expect(zoneLayer('Bearish order block 1h')).toBe('ob');
    expect(levelLayer('EQH')).toBe('liquidity');
    expect(levelLayer('RANGE_EQ')).toBe('ranges');
    expect(levelLayer('OPEN_D')).toBe('sessions');
    expect(levelLayer('SESL')).toBe('sessions');
    expect(levelLayer('INVALIDATION')).toBeNull();
  });
  it('builds range bands from the API range and does not invent prices', () => {
    const items = buildOverlays(analysis, null);
    const prices = new Set(overlayPrices(items));
    for (const p of [104, 105, 109, 110, 111, 112, 100, 120, 107]) expect(prices.has(p)).toBe(true);
    expect(items.some((i) => i.id === 'L3')).toBe(false);
  });
  it('hides layers that are switched off and always keeps the plan', () => {
    const items = buildOverlays(analysis, null);
    const shown = visible(items, { ...DEFAULT_LAYERS, fvg: false, sessions: false });
    expect(shown.some((i) => i.layer === 'fvg')).toBe(false);
    expect(shown.some((i) => i.layer === 'sessions')).toBe(false);
    expect(shown.some((i) => i.layer === 'liquidity')).toBe(true);
  });
});

describe('focusOverlays', () => {
  const zone = (id: string, price: number): Overlay => ({
    kind: 'zone',
    layer: 'fvg',
    id,
    label: id,
    top: price + 5,
    bottom: price - 5,
    tone: 'fvg',
  });

  it('keeps everything when there are few levels', () => {
    const few = [zone('a', 100), zone('b', 200)];
    expect(focusOverlays(few, 14)).toEqual({ shown: few, hidden: 0 });
  });

  it('keeps the plan lines and the levels nearest the price, and counts the rest', () => {
    const many = Array.from({ length: 40 }, (_, i) => zone(`z${i}`, 60_000 + i * 1000));
    const stop: Overlay = {
      kind: 'line',
      layer: 'plan',
      id: 'stop',
      label: 'Stop',
      price: 99_000,
      tone: 'stop',
    };
    const r = focusOverlays([...many, stop], 10);
    expect(r.shown).toHaveLength(10);
    expect(r.hidden).toBe(31);
    expect(r.shown.some((o) => o.id === 'stop')).toBe(true);
    // The median level is near 80,000, so the far ends are left out.
    expect(r.shown.some((o) => o.id === 'z0')).toBe(false);
    expect(r.shown.some((o) => o.id === 'z39')).toBe(false);
  });
});

describe('focusOverlays with a real price', () => {
  it('centres on the given price, not on the median level', () => {
    const z = (id: string, price: number): Overlay => ({
      kind: 'zone',
      layer: 'fvg',
      id,
      label: id,
      top: price + 5,
      bottom: price - 5,
      tone: 'fvg',
    });
    const many = Array.from({ length: 40 }, (_, i) => z(`z${i}`, 60_000 + i * 1000));
    // The median is near 80,000, but the price is 61,000: the low levels are the ones kept.
    const r = focusOverlays(many, 6, 61_000);
    expect(r.shown.some((o) => o.id === 'z1')).toBe(true);
    expect(r.shown.some((o) => o.id === 'z39')).toBe(false);
  });
});

describe('relevantForTf', () => {
  const z = (label: string, layer: Overlay['layer'] = 'fvg'): Overlay => ({
    kind: 'zone',
    layer,
    id: label,
    label,
    top: 2,
    bottom: 1,
    tone: 'fvg',
  });
  it('drops levels from lower timeframes than the chart, keeps equal, higher and unlabelled ones', () => {
    const items = [
      z('Bearish FVG 15m'),
      z('Bullish FVG 1h'),
      z('Bullish order block 1d'),
      z('Equal highs'),
      z('Entry zone', 'plan'),
    ];
    expect(relevantForTf(items, '1h').map((o) => o.id)).toEqual([
      'Bullish FVG 1h',
      'Bullish order block 1d',
      'Equal highs',
      'Entry zone',
    ]);
    expect(relevantForTf(items, '1d').map((o) => o.id)).toEqual([
      'Bullish order block 1d',
      'Equal highs',
      'Entry zone',
    ]);
    expect(relevantForTf(items, '5m')).toHaveLength(5);
  });
});

describe('stackLabels', () => {
  it('spaces crowded labels apart in order and keeps lone ones where they are', () => {
    const out = stackLabels([50, 50.5, 51, 10], 4);
    expect(out[3]).toBe(10);
    const crowded = [out[0] as number, out[1] as number, out[2] as number].sort((a, b) => a - b);
    expect((crowded[1] as number) - (crowded[0] as number)).toBeGreaterThanOrEqual(4 - 1e-9);
    expect((crowded[2] as number) - (crowded[1] as number)).toBeGreaterThanOrEqual(4 - 1e-9);
  });

  it('shifts the stack up when it would run off the bottom', () => {
    const out = stackLabels([98, 99, 100], 5);
    expect(Math.max(...out)).toBeLessThanOrEqual(100);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
  });
});
