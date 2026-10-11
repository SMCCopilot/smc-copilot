import type { Candle } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import { FLAG, normalize, parseNumber, type RawCandle } from '../src/candle.js';
import {
  CORE_VALIDATION,
  ON_DEMAND_VALIDATION,
  type ValidationContext,
  validate,
} from '../src/validate.js';

const T0 = 1_760_000_040_000; // aligned to the minute
const ID = 'BINANCE:PERP:BTCUSDT';

const raw = (over: Partial<RawCandle> = {}): RawCandle => ({
  venueSymbol: 'BTCUSDT',
  marketType: 'PERP',
  tf: '1m',
  openTimeMs: T0,
  o: '64000.10',
  h: '64020.50',
  l: '63990.00',
  c: '64010.00',
  v: '12.345',
  closed: true,
  receivedAtMs: T0 + 61_000,
  ...over,
});

const candle = (over: Partial<Candle> = {}): Candle => ({
  instrumentId: ID,
  tf: '1m',
  openTime: T0,
  o: 64000.1,
  h: 64020.5,
  l: 63990,
  c: 64010,
  v: 12.345,
  closed: true,
  providerId: 'binance',
  ...over,
});

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  nowMs: T0 + 61_000,
  ...over,
});

describe('parseNumber', () => {
  it.each([
    ['64000.10', 64000.1],
    ['0.00001', 0.00001],
    ['1e-7', 1e-7],
    [5, 5],
  ])('parses %j', (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  it.each(['', 'abc', '1,000', '0x10', 'Infinity', '12.', '.5', undefined])(
    'rejects %j',
    (input) => {
      expect(Number.isNaN(parseNumber(input as string))).toBe(true);
    },
  );
});

describe('normalize (V1, V2)', () => {
  it('produces a candle with 8 decimal rounding', () => {
    const r = normalize(raw({ o: '1.123456789', h: '2', l: '1', c: '1.5' }), ID, 'binance');
    expect(r).toMatchObject({
      ok: true,
      candle: { o: 1.12345679, instrumentId: ID, providerId: 'binance' },
    });
  });

  it.each([
    ['zero price', { l: '0' }],
    ['negative price', { o: '-1' }],
    ['NaN price', { c: 'abc' }],
    ['infinite price', { h: Number.POSITIVE_INFINITY }],
    ['negative volume', { v: '-1' }],
    ['garbage volume', { v: 'lots' }],
  ])('V2 rejects %s', (_label, over) => {
    expect(normalize(raw(over as Partial<RawCandle>), ID, 'binance')).toEqual({
      ok: false,
      reason: 'NON_POSITIVE',
    });
  });

  it.each([
    ['high below close', { h: '64000' }],
    ['low above open', { l: '64005' }],
    ['high below low', { h: '63980', l: '63990', o: '63985', c: '63985' }],
  ])('V1 rejects %s', (_label, over) => {
    expect(normalize(raw(over as Partial<RawCandle>), ID, 'binance')).toEqual({
      ok: false,
      reason: 'BAD_OHLC',
    });
  });

  it('allows zero volume', () => {
    expect(normalize(raw({ v: '0' }), ID, 'binance')).toMatchObject({ ok: true });
  });
});

describe('validate', () => {
  it('accepts a clean candle with no flags', () => {
    expect(validate(candle(), ctx())).toEqual({
      ok: true,
      flags: 0,
      duplicate: false,
      crosscheck: 'NO_PEER',
    });
  });

  it('V3 rejects a candle not aligned to its timeframe', () => {
    expect(validate(candle({ openTime: T0 + 1 }), ctx())).toEqual({
      ok: false,
      reason: 'MISALIGNED',
    });
    expect(validate(candle({ tf: '5m', openTime: T0 }), ctx())).toEqual({
      ok: false,
      reason: 'MISALIGNED',
    });
  });

  it('V4 rejects a future candle but tolerates 2 s of skew', () => {
    const future = candle({ openTime: T0 + 60_000 });
    expect(validate(future, ctx({ nowMs: T0 }))).toEqual({ ok: false, reason: 'FUTURE_TS' });
    expect(validate(candle(), ctx({ nowMs: T0 - 2000 }))).toMatchObject({ ok: true });
    expect(validate(candle(), ctx({ nowMs: T0 - 2001 }))).toEqual({
      ok: false,
      reason: 'FUTURE_TS',
    });
  });

  describe('V5 duplicates', () => {
    it('is a harmless repeat when the stored candle is identical', () => {
      expect(validate(candle(), ctx({ existing: candle() }))).toMatchObject({
        ok: true,
        duplicate: true,
      });
    });
    it('keeps the first when values differ', () => {
      expect(validate(candle({ c: 64011 }), ctx({ existing: candle() }))).toEqual({
        ok: false,
        reason: 'CONFLICTING_DUPLICATE',
      });
    });
  });

  describe('V6 spike', () => {
    it('flags a range above the cap and not at the cap', () => {
      const at = candle({ o: 100, h: 115, l: 100, c: 100 }); // 15% of close
      const over = candle({ o: 100, h: 115.01, l: 100, c: 100 });
      expect((validate(at, ctx()) as { flags: number }).flags & FLAG.SPIKE_SUSPECT).toBe(0);
      expect((validate(over, ctx()) as { flags: number }).flags & FLAG.SPIKE_SUSPECT).toBe(
        FLAG.SPIKE_SUSPECT,
      );
    });
    it('uses the wider cap for on-demand pairs', () => {
      const wide = candle({ o: 100, h: 120, l: 100, c: 100 });
      expect((validate(wide, ctx(), CORE_VALIDATION) as { flags: number }).flags).toBe(
        FLAG.SPIKE_SUSPECT,
      );
      expect((validate(wide, ctx(), ON_DEMAND_VALIDATION) as { flags: number }).flags).toBe(0);
    });
  });

  describe('V7 cross-check', () => {
    const peer = (close: number, instrumentId = 'BYBIT:PERP:BTCUSDT') => ({ instrumentId, close });
    it('agrees within tolerance', () => {
      expect(validate(candle(), ctx({ peer: peer(64005) }))).toMatchObject({
        flags: 0,
        crosscheck: 'AGREE',
      });
    });
    it('flags divergence beyond 0.15%', () => {
      const r = validate(candle(), ctx({ peer: peer(64010 * 1.002) }));
      expect(r).toMatchObject({ crosscheck: 'DIVERGE', flags: FLAG.CROSSCHECK_DIVERGENCE });
    });
    it('reports NO_PEER explicitly when nothing was compared (never "verified")', () => {
      expect(validate(candle(), ctx())).toMatchObject({ crosscheck: 'NO_PEER' });
    });
    it('refuses to compare a perp with a spot peer by construction', () => {
      expect(() => validate(candle(), ctx({ peer: peer(64010, 'BINANCE:SPOT:BTCUSDT') }))).toThrow(
        /cross-market-type/,
      );
    });
  });

  it('V8 flags a flat candle', () => {
    const flat = candle({ o: 100, h: 100, l: 100, c: 100 });
    expect((validate(flat, ctx()) as { flags: number }).flags).toBe(FLAG.FLAT);
  });

  describe('V9 open versus previous close', () => {
    const prev = candle({ openTime: T0 - 60_000, c: 64000 });
    it('is clean when the open continues the previous close', () => {
      expect(
        (validate(candle({ o: 64000.5 }), ctx({ previous: prev })) as { flags: number }).flags,
      ).toBe(0);
    });
    it('flags a jump beyond tolerance', () => {
      expect(
        (validate(candle({ o: 64200 }), ctx({ previous: prev })) as { flags: number }).flags,
      ).toBe(FLAG.GAP_PRICE);
    });
    it('ignores a previous candle that is not adjacent (a gap is handled by gap detection)', () => {
      const old = candle({ openTime: T0 - 300_000, c: 50000 });
      expect((validate(candle(), ctx({ previous: old })) as { flags: number }).flags).toBe(0);
    });
  });

  it('combines soft flags', () => {
    const c = candle({ o: 100, h: 130, l: 100, c: 100 });
    const peer = { instrumentId: 'BYBIT:PERP:BTCUSDT', close: 110 };
    const r = validate(c, ctx({ peer }));
    expect((r as { flags: number }).flags).toBe(FLAG.SPIKE_SUSPECT | FLAG.CROSSCHECK_DIVERGENCE);
  });
});
