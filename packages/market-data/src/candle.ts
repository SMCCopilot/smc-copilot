import { CANDLE_FLAGS, type Candle, type MarketType, type Timeframe } from '@smc/contracts';

/** A venue-shaped candle: untrusted, strings or numbers, nothing validated (A03 section 3). */
export interface RawCandle {
  readonly venueSymbol: string;
  readonly marketType: MarketType;
  readonly tf: Timeframe;
  readonly openTimeMs: number;
  readonly o: string | number;
  readonly h: string | number;
  readonly l: string | number;
  readonly c: string | number;
  readonly v?: string | number | undefined;
  /** Venue's own "this candle is final" flag. Only closed candles ever reach the engine. */
  readonly closed: boolean;
  readonly receivedAtMs: number;
}

/** A candle that passed normalisation and validation, with its quality flags (`candles.flags`). */
export interface StoredCandle extends Candle {
  readonly flags: number;
  readonly status: 'CLOSED' | 'INCOMPLETE';
}

export const FLAG = CANDLE_FLAGS;

export type NormalizeFailure = 'NON_POSITIVE' | 'BAD_OHLC';

/** Parses a venue number once. Anything that is not a plain finite decimal becomes NaN and is rejected later. */
export function parseNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim())) {
    return Number.NaN;
  }
  return Number(value);
}

/** Prices are stored as numeric(20,8); round to 8 decimals so the same candle always serialises the same way. */
export const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

export function normalize(
  raw: RawCandle,
  instrumentId: string,
  providerId: string,
): { ok: true; candle: Candle } | { ok: false; reason: NormalizeFailure } {
  const o = round8(parseNumber(raw.o));
  const h = round8(parseNumber(raw.h));
  const l = round8(parseNumber(raw.l));
  const c = round8(parseNumber(raw.c));
  const v = raw.v === undefined ? 0 : parseNumber(raw.v);

  // V2: finite and strictly positive (volume may be zero but not negative or garbage).
  if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0) || !Number.isFinite(v) || v < 0) {
    return { ok: false, reason: 'NON_POSITIVE' };
  }
  // V1: low <= open,close <= high.
  if (!(l <= Math.min(o, c) && h >= Math.max(o, c))) return { ok: false, reason: 'BAD_OHLC' };

  return {
    ok: true,
    candle: {
      instrumentId,
      tf: raw.tf,
      openTime: raw.openTimeMs,
      o,
      h,
      l,
      c,
      v: round8(v),
      closed: raw.closed,
      providerId,
    },
  };
}
