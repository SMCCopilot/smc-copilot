import type { MarketType } from '@smc/contracts';
import type { RawCandle } from './candle.js';

/**
 * Venue WebSocket frame -> raw candles. Pure, used by the live adapters and by the replay adapter, so a
 * recording goes through exactly the code the live feed does (A03 section 3.1). Frames are untrusted:
 * anything unexpected yields no candles rather than an exception.
 */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface ParseOptions {
  /** Also emit updates of the candle that is still forming. Off by default: only closed candles reach the engine. */
  readonly includeForming?: boolean;
}

export function parseBinanceFrame(
  text: string,
  marketType: MarketType,
  receivedAtMs: number,
  options: ParseOptions = {},
): RawCandle[] {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return [];
  }
  // Combined streams wrap the event in {stream, data}; single streams send the event itself.
  const event = (msg as { data?: unknown })?.data ?? msg;
  const k = (event as { k?: Record<string, unknown> })?.k;
  if ((event as { e?: unknown })?.e !== 'kline' || !k || k.i !== '1m') return [];

  const symbol = str(k.s);
  const openTimeMs = num(k.t);
  const o = str(k.o);
  const h = str(k.h);
  const l = str(k.l);
  const c = str(k.c);
  if (!symbol || openTimeMs === null || !o || !h || !l || !c) return [];

  const closed = k.x === true;
  if (!closed && !options.includeForming) return [];
  return [
    {
      venueSymbol: symbol,
      marketType,
      tf: '1m',
      openTimeMs,
      o,
      h,
      l,
      c,
      v: str(k.v) ?? undefined,
      closed,
      receivedAtMs,
    },
  ];
}

export function parseBybitFrame(
  text: string,
  receivedAtMs: number,
  options: ParseOptions = {},
): RawCandle[] {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return [];
  }
  const topic = str((msg as { topic?: unknown })?.topic);
  const data = (msg as { data?: unknown })?.data;
  const match = topic ? /^kline\.1\.([A-Z0-9]+)$/.exec(topic) : null;
  if (!match?.[1] || !Array.isArray(data)) return [];

  const out: RawCandle[] = [];
  for (const row of data as Record<string, unknown>[]) {
    const openTimeMs = num(row.start);
    const o = str(row.open);
    const h = str(row.high);
    const l = str(row.low);
    const c = str(row.close);
    if (openTimeMs === null || !o || !h || !l || !c) continue;
    const closed = row.confirm === true;
    if (!closed && !options.includeForming) continue;
    out.push({
      venueSymbol: match[1],
      marketType: 'PERP',
      tf: '1m',
      openTimeMs,
      o,
      h,
      l,
      c,
      v: str(row.volume) ?? undefined,
      closed,
      receivedAtMs,
    });
  }
  return out;
}
