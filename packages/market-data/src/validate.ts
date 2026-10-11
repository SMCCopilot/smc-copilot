import { assertSameMarketType, type Candle, TIMEFRAME_MS } from '@smc/contracts';
import { FLAG } from './candle.js';

export type QuarantineReason =
  | 'NON_POSITIVE'
  | 'BAD_OHLC'
  | 'MISALIGNED'
  | 'FUTURE_TS'
  | 'CONFLICTING_DUPLICATE'
  | 'UNMAPPED_SYMBOL';

export interface ValidationConfig {
  /** V6: (high - low) / close above this percentage marks SPIKE_SUSPECT. */
  readonly spikeCapPct: number;
  /** V7: close versus the same-market-type peer venue. */
  readonly crosscheckTolPct: number;
  /** V9: open versus the previous close; crypto trades continuously. */
  readonly gapPriceTolPct: number;
  /** V4: tolerated clock skew when comparing a candle open with "now". */
  readonly futureSkewMs: number;
}

/** Core pairs (A03 section 5.2). */
export const CORE_VALIDATION: ValidationConfig = {
  spikeCapPct: 15,
  crosscheckTolPct: 0.15,
  gapPriceTolPct: 0.1,
  futureSkewMs: 2000,
};

/** On-demand (thin) pairs get wider tolerances. */
export const ON_DEMAND_VALIDATION: ValidationConfig = {
  ...CORE_VALIDATION,
  spikeCapPct: 30,
  crosscheckTolPct: 0.4,
};

export interface ValidationContext {
  readonly nowMs: number;
  /** Canonical id of the candle's own instrument (needed to refuse a cross-market-type peer). */
  readonly canonical?: string | undefined;
  /** The stored candle with the same key, if any (V5). */
  readonly existing?: Candle | undefined;
  /** The stored candle for the minute before this one (V9). Ignored unless it is exactly adjacent. */
  readonly previous?: Candle | undefined;
  /** Peer venue candle for the same open time. `peerInstrumentId` is checked for the same market type (V7). */
  readonly peer?: { readonly instrumentId: string; readonly close: number } | undefined;
}

export type CrosscheckState = 'NO_PEER' | 'AGREE' | 'DIVERGE';

export type ValidationResult =
  | {
      readonly ok: true;
      readonly flags: number;
      /** True when the key already exists with identical values: nothing to write. */
      readonly duplicate: boolean;
      readonly crosscheck: CrosscheckState;
    }
  | { readonly ok: false; readonly reason: QuarantineReason };

const pctDiff = (a: number, b: number): number => (Math.abs(a - b) / b) * 100;
const sameOhlc = (a: Candle, b: Candle): boolean =>
  a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c;

/**
 * Rules V1/V2 live in `normalize`. Hard rules reject into quarantine, soft rules only set flags (A03 section 5.2).
 * Pure: the caller supplies "now", the stored neighbours and the peer close.
 */
export function validate(
  candle: Candle,
  ctx: ValidationContext,
  config: ValidationConfig = CORE_VALIDATION,
): ValidationResult {
  const tfMs = TIMEFRAME_MS[candle.tf];

  // V3: aligned to the timeframe boundary in UTC.
  if (candle.openTime % tfMs !== 0) return { ok: false, reason: 'MISALIGNED' };
  // V4: not in the future.
  if (candle.openTime > ctx.nowMs + config.futureSkewMs) return { ok: false, reason: 'FUTURE_TS' };
  // V5: a closed candle never changes. Same values = harmless repeat; different values = keep the first.
  if (ctx.existing) {
    return sameOhlc(ctx.existing, candle)
      ? { ok: true, flags: 0, duplicate: true, crosscheck: 'NO_PEER' }
      : { ok: false, reason: 'CONFLICTING_DUPLICATE' };
  }

  let flags = 0;
  // V6: implausible range for one candle.
  if (((candle.h - candle.l) / candle.c) * 100 > config.spikeCapPct) flags |= FLAG.SPIKE_SUSPECT;
  // V8: flat candle on a liquid pair is a stale-feed signal.
  if (candle.h === candle.l) flags |= FLAG.FLAT;
  // V9: open should match the previous close.
  const prev = ctx.previous;
  if (
    prev &&
    prev.openTime === candle.openTime - tfMs &&
    pctDiff(candle.o, prev.c) > config.gapPriceTolPct
  ) {
    flags |= FLAG.GAP_PRICE;
  }

  // V7: compare with the peer, same market type only (invariant 7).
  let crosscheck: CrosscheckState = 'NO_PEER';
  if (ctx.peer) {
    if (!ctx.canonical) throw new Error('validate: canonical is required when a peer is supplied');
    assertSameMarketType(ctx.canonical, ctx.peer.instrumentId);
    if (pctDiff(candle.c, ctx.peer.close) > config.crosscheckTolPct) {
      flags |= FLAG.CROSSCHECK_DIVERGENCE;
      crosscheck = 'DIVERGE';
    } else {
      crosscheck = 'AGREE';
    }
  }
  return { ok: true, flags, duplicate: false, crosscheck };
}
