import { describe, expect, it } from 'vitest';
import {
  binanceSymbol,
  klinesUrl,
  klineToCandle,
  mergeCandle,
  parseFrame,
  rowToCandle,
  streamUrl,
} from './binance-direct';

describe('binance direct feed helpers', () => {
  it('only Binance instruments have a direct symbol', () => {
    expect(binanceSymbol('BINANCE:PERP:BTCUSDT')).toBe('BTCUSDT');
    expect(binanceSymbol('BINANCE:SPOT:SOLUSDT')).toBe('SOLUSDT');
    expect(binanceSymbol('BYBIT:PERP:BTCUSDT')).toBeNull();
    expect(binanceSymbol('BINANCE:SPOT:bad symbol')).toBeNull();
  });

  it('builds the market-data addresses for spot and perp', () => {
    expect(klinesUrl('SPOT', 'BTCUSDT', '15m')).toBe(
      'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=500',
    );
    expect(klinesUrl('PERP', 'ETHUSDT', '1h', 100)).toBe(
      'https://fapi.binance.com/fapi/v1/klines?symbol=ETHUSDT&interval=1h&limit=100',
    );
    expect(streamUrl('SPOT', 'BTCUSDT', '4h')).toBe(
      'wss://data-stream.binance.vision/stream?streams=btcusdt@kline_4h',
    );
    expect(streamUrl('PERP', 'SOLUSDT', '1m')).toBe(
      'wss://fstream.binance.com/market/stream?streams=solusdt@kline_1m',
    );
  });

  it('turns a REST row into a candle, closed or still forming', () => {
    const row = [1_700_000_000_000, '100', '110', '95', '105', '12.5', 1_700_000_899_999];
    expect(rowToCandle(row, 1_700_001_000_000)).toMatchObject({
      o: 100,
      h: 110,
      l: 95,
      c: 105,
      v: 12.5,
      status: 'CLOSED',
    });
    expect(rowToCandle(row, 1_700_000_500_000).status).toBe('INCOMPLETE');
  });

  it('reads a kline frame and ignores everything else', () => {
    const frame = JSON.stringify({
      stream: 'btcusdt@kline_1m',
      data: { e: 'kline', k: { t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '9', x: false } },
    });
    const k = parseFrame(frame);
    expect(k && klineToCandle(k)).toMatchObject({ c: 1.5, status: 'INCOMPLETE' });
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame(JSON.stringify({ result: null, id: 1 }))).toBeNull();
  });

  it('updates the forming candle in place, appends a new one, and ignores an old one', () => {
    const c = (t: number, close: number) =>
      ({
        openTime: new Date(t).toISOString(),
        o: 1,
        h: 2,
        l: 0,
        c: close,
        v: 1,
        status: 'INCOMPLETE',
      }) as const;
    const a = [c(1000, 1), c(2000, 2)];
    expect(mergeCandle(a, c(2000, 5)).map((x) => x.c)).toEqual([1, 5]);
    expect(mergeCandle(a, c(3000, 7)).map((x) => x.c)).toEqual([1, 2, 7]);
    expect(mergeCandle(a, c(500, 9))).toBe(a);
    expect(mergeCandle([], c(1, 1))).toHaveLength(1);
    expect(mergeCandle(a, c(3000, 7), 2).map((x) => x.c)).toEqual([2, 7]);
  });
});
