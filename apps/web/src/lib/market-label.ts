import type { InstrumentDto } from './queries';

const VENUE_NAME: Record<string, string> = {
  BINANCE: 'Binance',
  BYBIT: 'Bybit',
  COINBASE: 'Coinbase',
  KRAKEN: 'Kraken',
};

/** "BTC/USDT" from a canonical id like "BINANCE:PERP:BTCUSDT". */
export function pairOf(canonical: string): string {
  const sym = canonical.split(':').pop() ?? canonical;
  const m = /^(.+?)(USDT|USDC|BUSD|USD|EUR)$/.exec(sym);
  return m ? `${m[1]}/${m[2]}` : sym;
}

/** "BTC/USDT Perp · Binance" for a market picker. */
export function marketName(i: Pick<InstrumentDto, 'canonical' | 'venue' | 'marketType'>): string {
  return `${pairOf(i.canonical)} ${i.marketType === 'PERP' ? 'Perp' : 'Spot'} · ${VENUE_NAME[i.venue] ?? i.venue}`;
}

/** The chart's title: "BTC/USDT · Binance · 1D". */
export function chartTitle(
  i: Pick<InstrumentDto, 'canonical' | 'venue' | 'marketType'>,
  tf: string,
): string {
  const kind = i.marketType === 'PERP' ? ' Perp' : '';
  return `${pairOf(i.canonical)}${kind} · ${VENUE_NAME[i.venue] ?? i.venue} · ${tf.toUpperCase()}`;
}
