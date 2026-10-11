import { describe, expect, it } from 'vitest';
import { closedCandles, percentile, summarizeLags } from '../src/lag.mjs';

const binance = (x, T = 1_760_000_059_999) =>
  JSON.stringify({
    stream: 'btcusdt@kline_1m',
    data: { e: 'kline', E: T + 100, s: 'BTCUSDT', k: { t: T - 59_999, T, i: '1m', x } },
  });

const bybit = (confirm, end = 1_760_000_059_999) =>
  JSON.stringify({
    topic: 'kline.1.BTCUSDT',
    type: 'snapshot',
    data: [{ start: end - 59_999, end, interval: '1', confirm }],
  });

describe('closedCandles', () => {
  it('returns the close time of a closed Binance kline only', () => {
    expect(closedCandles('binance', binance(true))).toEqual([{ closeTimeMs: 1_760_000_059_999 }]);
    expect(closedCandles('binance', binance(false))).toEqual([]);
  });

  it('returns closed Bybit candles only', () => {
    expect(closedCandles('bybit', bybit(true))).toEqual([{ closeTimeMs: 1_760_000_059_999 }]);
    expect(closedCandles('bybit', bybit(false))).toEqual([]);
  });

  it.each([
    ['not json', 'pong'],
    ['subscription ack', '{"result":null,"id":1}'],
    ['bybit ack', '{"success":true,"op":"subscribe"}'],
    ['empty', ''],
  ])('ignores %s', (_label, text) => {
    expect(closedCandles('binance', text)).toEqual([]);
    expect(closedCandles('bybit', text)).toEqual([]);
  });

  it('ignores a malformed kline without throwing', () => {
    expect(closedCandles('binance', '{"data":{"k":{"x":true}}}')).toEqual([]);
  });
});

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
  });

  it('is order independent and null for no data', () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([], 95)).toBeNull();
  });
});

describe('summarizeLags', () => {
  it('reports count, p50, p95 and max', () => {
    expect(summarizeLags([100, 200, 300, 400])).toEqual({ n: 4, p50: 200, p95: 400, max: 400 });
  });

  it('reports an empty sample honestly', () => {
    expect(summarizeLags([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });
});
