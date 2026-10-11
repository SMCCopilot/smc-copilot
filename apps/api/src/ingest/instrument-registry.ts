import { assertSameMarketType, type MarketType, type Venue } from '@smc/contracts';
import type { Sql } from '@smc/db';

export interface InstrumentRow {
  readonly id: string;
  readonly canonical: string;
  readonly venue: Venue;
  readonly marketType: MarketType;
  readonly venueSymbol: string;
  readonly display: string;
  readonly providerId: string;
  readonly analysisEnabled: boolean;
  readonly active: boolean;
}

const key = (providerId: string, marketType: string, venueSymbol: string) =>
  `${providerId}|${marketType}|${venueSymbol.toUpperCase()}`;

/**
 * In-memory view of the instrument master and its routing aliases (A03 section 4.1). PRIMARY aliases say which
 * adapter serves an instrument; CROSSCHECK aliases name the peer series (same market type only, invariant 7).
 */
export class InstrumentRegistry {
  private readonly byId = new Map<string, InstrumentRow>();
  private readonly byProviderKey = new Map<string, InstrumentRow>();
  private readonly peers = new Map<string, InstrumentRow>(); // primary id -> peer instrument
  private readonly crosscheckVenues = new Set<string>(); // venues allowed to act as a V7 peer
  private readonly reverse = new Map<string, InstrumentRow[]>(); // peer id -> primaries it checks

  static async load(sql: Sql): Promise<InstrumentRegistry> {
    const instruments = await sql<
      {
        id: string;
        canonical: string;
        venue_id: Venue;
        market_type: MarketType;
        venue_symbol: string;
        display: string;
        active: boolean;
        provider_id: string;
        analysis_enabled: boolean;
        venue_enabled: boolean;
        crosscheck_enabled: boolean;
      }[]
    >`select i.id, i.canonical, i.venue_id, i.market_type, i.venue_symbol, i.display, i.active,
             v.provider_id, v.analysis_enabled, v.enabled as venue_enabled, v.crosscheck_enabled
        from instruments i join venues v on v.id = i.venue_id`;
    const aliases = await sql<
      {
        instrument_id: string;
        provider_id: string;
        venue_symbol: string;
        market_type: MarketType;
        role: string;
      }[]
    >`select instrument_id, provider_id, venue_symbol, market_type, role from instrument_aliases`;

    const registry = new InstrumentRegistry();
    for (const r of instruments) {
      if (!r.venue_enabled) continue; // a disabled venue (geo-block, terms problem) serves nothing
      if (r.crosscheck_enabled) registry.crosscheckVenues.add(r.venue_id);
      registry.byId.set(r.id, {
        id: r.id,
        canonical: r.canonical,
        venue: r.venue_id,
        marketType: r.market_type,
        venueSymbol: r.venue_symbol,
        display: r.display,
        providerId: r.provider_id,
        analysisEnabled: r.analysis_enabled,
        active: r.active,
      });
    }
    for (const a of aliases) {
      const instrument = registry.byId.get(a.instrument_id);
      if (!instrument?.active) continue;
      if (a.role === 'PRIMARY') {
        registry.byProviderKey.set(key(a.provider_id, a.market_type, a.venue_symbol), instrument);
      }
    }
    for (const a of aliases) {
      if (a.role !== 'CROSSCHECK') continue;
      const primary = registry.byId.get(a.instrument_id);
      const peer = registry.byProviderKey.get(key(a.provider_id, a.market_type, a.venue_symbol));
      if (!primary?.active || !peer || peer.id === primary.id) continue;
      // A peer on a venue whose cross-check is switched off (OKX, Coinbase, Kraken at MVP) does not count.
      if (!registry.crosscheckVenues.has(peer.venue)) continue;
      assertSameMarketType(primary.canonical, peer.canonical); // a spot/perp pairing is refused at load time
      registry.peers.set(primary.id, peer);
      registry.reverse.set(peer.id, [...(registry.reverse.get(peer.id) ?? []), primary]);
    }
    return registry;
  }

  get(id: string): InstrumentRow | undefined {
    return this.byId.get(id);
  }

  /** The instrument a venue symbol on `providerId` belongs to, or undefined (counted as unmapped, never guessed). */
  forVenueSymbol(
    providerId: string,
    marketType: MarketType,
    venueSymbol: string,
  ): InstrumentRow | undefined {
    return this.byProviderKey.get(key(providerId, marketType, venueSymbol));
  }

  peerOf(primaryId: string): InstrumentRow | undefined {
    return this.peers.get(primaryId);
  }

  primariesCheckedBy(peerId: string): readonly InstrumentRow[] {
    return this.reverse.get(peerId) ?? [];
  }

  all(): InstrumentRow[] {
    return [...this.byProviderKey.values()];
  }
}
