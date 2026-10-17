import type { AnalysisResponse } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildOverlays,
  DEFAULT_LAYERS,
  levelLayer,
  overlayPrices,
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
