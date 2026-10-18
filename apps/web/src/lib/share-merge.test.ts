import type { OcrContext } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import { keepKnown } from './share-merge';

const ctx = (derived: OcrContext['derived']): OcrContext => ({
  capturedAt: 1,
  roi: { w: 1920, h: 858 },
  texts: [],
  derived,
  engine: { name: 'tesseract-js', version: '7', backend: 'wasm', ms: 1 },
});

describe('keepKnown', () => {
  it('keeps the symbol, timeframe and venue from an earlier pass when a later pass misses them', () => {
    const first = ctx({ symbolText: 'BTCUSDT', tfText: '1D', venueText: 'OKX', lastPrice: 81689 });
    const second = ctx({ lastPrice: 81680, platform: 'UNKNOWN' });
    expect(keepKnown(first, second).derived).toMatchObject({
      symbolText: 'BTCUSDT',
      tfText: '1D',
      venueText: 'OKX',
      lastPrice: 81680,
    });
  });

  it('lets a newly read symbol replace the old one, and never keeps an old price', () => {
    const first = ctx({ symbolText: 'BTCUSDT', lastPrice: 81689 });
    const second = ctx({ symbolText: 'ETHUSDT' });
    const merged = keepKnown(first, second).derived;
    expect(merged?.symbolText).toBe('ETHUSDT');
    expect(merged?.lastPrice).toBeUndefined();
  });

  it('returns the first read as it is', () => {
    const only = ctx({ lastPrice: 5 });
    expect(keepKnown(null, only)).toBe(only);
  });
});
