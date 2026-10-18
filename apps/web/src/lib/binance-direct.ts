import type { MarketType, Timeframe } from '@smc/contracts';
import type { CandleRow } from './market';

/**
 * Live prices straight from Binance's public market-data endpoints to the user's browser. Our servers do not relay
 * these prices: this is the same thing as opening Binance's own chart. Spot uses the market-data-only hosts, perps
 * the futures hosts (the same addresses the server's own feed uses).
 */
export const BINANCE = {
  SPOT: {
    rest: 'https://data-api.binance.vision/api/v3/klines',
    ws: 'wss://data-stream.binance.vision',
  },
  PERP: { rest: 'https://fapi.binance.com/fapi/v1/klines', ws: 'wss://fstream.binance.com/market' },
} as const satisfies Record<MarketType, { rest: string; ws: string }>;

/** The venue symbol for a Binance instrument ("BINANCE:PERP:BTCUSDT" gives "BTCUSDT"), else null. */
export function binanceSymbol(canonical: string): string | null {
  const m = /^BINANCE:(?:SPOT|PERP):([A-Z0-9]{4,20})$/.exec(canonical);
  return m?.[1] ?? null;
}

export const klinesUrl = (market: MarketType, symbol: string, tf: Timeframe, limit = 500): string =>
  `${BINANCE[market].rest}?symbol=${encodeURIComponent(symbol)}&interval=${tf}&limit=${limit}`;

export const streamUrl = (market: MarketType, symbol: string, tf: Timeframe): string =>
  `${BINANCE[market].ws}/stream?streams=${symbol.toLowerCase()}@kline_${tf}`;

const num = (x: unknown): number => Number(x);

/** One REST kline row: [openTime, open, high, low, close, volume, closeTime, ...]. */
export function rowToCandle(row: unknown[], now = Date.now()): CandleRow {
  const closeTime = num(row[6]);
  return {
    openTime: new Date(num(row[0])).toISOString(),
    o: num(row[1]),
    h: num(row[2]),
    l: num(row[3]),
    c: num(row[4]),
    v: num(row[5]),
    status: closeTime < now ? 'CLOSED' : 'INCOMPLETE',
  };
}

export interface WsKline {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  x: boolean;
}

export function klineToCandle(k: WsKline): CandleRow {
  return {
    openTime: new Date(k.t).toISOString(),
    o: num(k.o),
    h: num(k.h),
    l: num(k.l),
    c: num(k.c),
    v: num(k.v),
    status: k.x ? 'CLOSED' : 'INCOMPLETE',
  };
}

/** Pulls the kline out of a combined-stream frame; null for anything else (never throws on a bad frame). */
export function parseFrame(text: string): WsKline | null {
  try {
    const m = JSON.parse(text) as { data?: { e?: string; k?: WsKline } };
    const k = m.data?.k;
    return m.data?.e === 'kline' && k && typeof k.t === 'number' ? k : null;
  } catch {
    return null;
  }
}

/** Replaces the candle with the same open time, or appends a newer one. Older ones are ignored. Keeps `max` candles. */
export function mergeCandle(list: CandleRow[], c: CandleRow, max = 1000): CandleRow[] {
  const last = list[list.length - 1];
  if (!last) return [c];
  if (c.openTime === last.openTime) return [...list.slice(0, -1), c];
  if (c.openTime > last.openTime) return [...list, c].slice(-max);
  return list;
}
