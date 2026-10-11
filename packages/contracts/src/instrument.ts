import { z } from 'zod';

export const VENUES = ['BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'KRAKEN', 'FX_STUB'] as const;
export const VenueSchema = z.enum(VENUES);
export type Venue = z.infer<typeof VenueSchema>;

export const MARKET_TYPES = ['SPOT', 'PERP'] as const;
export const MarketTypeSchema = z.enum(MARKET_TYPES);
export type MarketType = z.infer<typeof MarketTypeSchema>;

export const ASSET_CLASSES = ['CRYPTO', 'FX'] as const;
export const AssetClassSchema = z.enum(ASSET_CLASSES);
export type AssetClass = z.infer<typeof AssetClassSchema>;

export const LICENSE_CLASSES = ['INTERNAL_ONLY', 'DISPLAY_OK', 'BYO_ONLY'] as const;
export const LicenseClassSchema = z.enum(LICENSE_CLASSES);
export type LicenseClass = z.infer<typeof LicenseClassSchema>;

/**
 * `VENUE:MARKET_TYPE:SYMBOL`, e.g. `BINANCE:PERP:BTCUSDT`. Symbols are upper case as the venue writes them
 * (`BTC-USD`, `XBT/USD`), so one instrument has exactly one canonical id.
 */
const CANONICAL_RE = /^([A-Z_]+):(SPOT|PERP):([A-Z0-9/_-]{1,40})$/;

export const CanonicalInstrumentSchema = z
  .string()
  .max(64)
  .regex(CANONICAL_RE)
  .refine((s) => VenueSchema.safeParse(s.split(':')[0]).success, { message: 'unknown venue' });
export type CanonicalInstrument = z.infer<typeof CanonicalInstrumentSchema>;

export interface InstrumentRef {
  readonly venue: Venue;
  readonly marketType: MarketType;
  readonly symbol: string;
}

export function parseCanonical(canonical: string): InstrumentRef {
  const m = CANONICAL_RE.exec(canonical);
  const venue = VenueSchema.safeParse(m?.[1]);
  if (!m || !venue.success) {
    throw new Error(`invalid canonical instrument: ${canonical.slice(0, 64)}`);
  }
  return { venue: venue.data, marketType: m[2] as MarketType, symbol: m[3] as string };
}

/** Builds the canonical id and re-validates it, so an id that could not be parsed back is never produced. */
export function formatCanonical(ref: InstrumentRef): CanonicalInstrument {
  const canonical = `${ref.venue}:${ref.marketType}:${ref.symbol}`;
  parseCanonical(canonical);
  return canonical;
}

/**
 * Invariant 7: an instrument is (venue, market type, symbol) and cross-checks compare the same market type only.
 * Callers that compare two series must go through this guard.
 */
export function assertSameMarketType(a: string, b: string): void {
  if (parseCanonical(a).marketType !== parseCanonical(b).marketType) {
    throw new Error(`cross-market-type comparison refused: ${a.slice(0, 64)} vs ${b.slice(0, 64)}`);
  }
}
