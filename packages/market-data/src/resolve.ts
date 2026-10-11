import type { MarketType, Venue } from '@smc/contracts';

export interface ResolvableInstrument {
  readonly id: string;
  readonly canonical: string;
  readonly venue: Venue;
  readonly marketType: MarketType;
  readonly display: string;
  /** Latest known price of this instrument, used to tell look-alike markets apart. */
  readonly lastPrice?: number | undefined;
}

export interface SearchKey {
  readonly key: string;
  readonly instrumentId: string;
  readonly weight: number;
}

export interface ResolveQuery {
  /** What the chart or the user called it: `BINANCE:BTCUSDT.P`, `Bitcoin`, `XBT/USD`. */
  readonly text: string;
  readonly venueText?: string | undefined;
  readonly isPerp?: boolean | undefined;
  readonly lastPrice?: number | undefined;
}

export interface ResolveCandidate {
  readonly instrument: ResolvableInstrument;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface ResolveResult {
  readonly candidates: readonly ResolveCandidate[];
  /** True when the best two candidates are too close to pick silently: ask the user once (A03 section 4.2). */
  readonly ambiguous: boolean;
}

const PERP_MARKERS = /(\.P|PERP|PERPETUAL|-SWAP|PERPETUALCONTRACT)$/;
const PRICE_REJECT_PCT = 5;
const PRICE_CLOSE_PCT = 0.5;
const AMBIGUITY_MARGIN = 10;

export interface NormalizedSymbol {
  readonly key: string;
  readonly venue: string | null;
  readonly perpMarker: boolean;
}

/** Uppercase, split off a venue prefix, detect perp markers, drop separators, map XBT to BTC (A03 section 4.2). */
export function normalizeSymbol(text: string): NormalizedSymbol {
  let t = text.trim().toUpperCase().replace(/\s+/g, '');
  let venue: string | null = null;
  const prefix = /^([A-Z]+):(.+)$/.exec(t);
  if (prefix?.[1] && prefix[2]) {
    venue = prefix[1];
    t = prefix[2];
  }
  const perpMarker = PERP_MARKERS.test(t);
  t = t.replace(PERP_MARKERS, '');
  t = t.replace(/[/\-_]/g, '').replace(/XBT/g, 'BTC');
  return { key: t, venue, perpMarker };
}

/**
 * Pure resolver shared by OCR hints, the vision fallback and the manual picker. Search keys only produce
 * candidates; venue text, perp markers and last-price proximity decide between them. A price more than 5% away
 * excludes a candidate (a different asset), and the spot/perp/USDT/USD look-alikes that remain are what the
 * ambiguity flag is for.
 */
export function resolveInstrument(
  query: ResolveQuery,
  keys: readonly SearchKey[],
  instruments: ReadonlyMap<string, ResolvableInstrument>,
): ResolveResult {
  const norm = normalizeSymbol(query.text);
  const venue = (query.venueText ? normalizeSymbol(query.venueText).key : norm.venue) ?? null;
  const perp = query.isPerp === true || norm.perpMarker;
  // A key may be stored with the perp marker folded in (BTCUSDTP), so try both spellings.
  const wanted = new Set([norm.key, `${norm.key}P`]);

  const best = new Map<string, number>();
  for (const k of keys)
    if (wanted.has(k.key))
      best.set(k.instrumentId, Math.max(best.get(k.instrumentId) ?? 0, k.weight));

  const candidates: ResolveCandidate[] = [];
  for (const [id, weight] of best) {
    const instrument = instruments.get(id);
    if (!instrument) continue;
    let score = weight;
    const reasons = [`key match (weight ${weight})`];

    if (venue) {
      if (instrument.venue === venue) {
        score += 40;
        reasons.push(`venue ${venue}`);
      } else {
        score -= 40;
        reasons.push(`venue differs from ${venue}`);
      }
    }
    if (perp) {
      score += instrument.marketType === 'PERP' ? 30 : -30;
      reasons.push(
        instrument.marketType === 'PERP' ? 'perp marker' : 'perp marker but spot market',
      );
    } else if (query.isPerp === false) {
      score += instrument.marketType === 'SPOT' ? 30 : -30;
      reasons.push(instrument.marketType === 'SPOT' ? 'spot' : 'spot chart but perp market');
    }
    if (
      query.lastPrice !== undefined &&
      instrument.lastPrice !== undefined &&
      instrument.lastPrice > 0
    ) {
      const diffPct =
        (Math.abs(query.lastPrice - instrument.lastPrice) / instrument.lastPrice) * 100;
      if (diffPct > PRICE_REJECT_PCT) continue;
      if (diffPct <= PRICE_CLOSE_PCT) {
        score += 20 - diffPct * 10;
        reasons.push(`price within ${diffPct.toFixed(2)}%`);
      }
    }
    candidates.push({ instrument, score, reasons });
  }

  candidates.sort(
    (a, b) => b.score - a.score || a.instrument.canonical.localeCompare(b.instrument.canonical),
  );
  const [first, second] = candidates;
  return {
    candidates,
    ambiguous: !!first && !!second && first.score - second.score < AMBIGUITY_MARGIN,
  };
}
