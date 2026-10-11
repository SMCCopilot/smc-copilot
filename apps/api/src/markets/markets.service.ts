import { Inject, Injectable } from '@nestjs/common';
import type { LicenseClass, MarketType, Timeframe, Venue } from '@smc/contracts';
import type { Sql } from '@smc/db';
import {
  type ResolvableInstrument,
  type ResolveQuery,
  type ResolveResult,
  resolveInstrument,
  type SearchKey,
} from '@smc/market-data';
import { SQL } from '../config/tokens.js';

export interface InstrumentDto {
  id: string;
  canonical: string;
  venue: Venue;
  marketType: MarketType;
  display: string;
  assetClass: 'CRYPTO';
  base: string;
  quote: string;
  pricePrecision: number;
  tickSize: number;
  /** What this deployment may show for the instrument. Anything but DISPLAY_OK means analysis only, no raw prices. */
  licenseClass: LicenseClass;
  rawDataAllowed: boolean;
}

interface InstrumentRowDb {
  id: string;
  canonical: string;
  venue_id: Venue;
  market_type: MarketType;
  display: string;
  base: string;
  quote: string;
  price_precision: number;
  tick_size: string;
  effective_class: LicenseClass;
}

const toDto = (r: InstrumentRowDb): InstrumentDto => ({
  id: r.id,
  canonical: r.canonical,
  venue: r.venue_id,
  marketType: r.market_type,
  display: r.display,
  assetClass: 'CRYPTO',
  base: r.base,
  quote: r.quote,
  pricePrecision: r.price_precision,
  tickSize: Number(r.tick_size),
  licenseClass: r.effective_class,
  rawDataAllowed: r.effective_class === 'DISPLAY_OK',
});

export interface CandleDto {
  openTime: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  status: 'CLOSED' | 'INCOMPLETE';
}

/** Read side of the market-data layer. Licence decisions always come from the `instrument_license` view (invariant 6). */
@Injectable()
export class MarketsService {
  constructor(@Inject(SQL) private readonly sql: Sql | null) {}

  private db(): Sql {
    if (!this.sql) throw new Error('database is not configured');
    return this.sql;
  }

  /** Instruments users may analyse: crypto on analysis-enabled venues only (cross-check series stay internal). */
  async list(): Promise<InstrumentDto[]> {
    const rows = await this.db()<InstrumentRowDb[]>`
      select i.id, i.canonical, i.venue_id, i.market_type, i.display, i.base, i.quote, i.price_precision,
             i.tick_size, l.effective_class
        from instruments i
        join venues v on v.id = i.venue_id
        join instrument_license l on l.instrument_id = i.id
       where i.active and v.enabled and v.analysis_enabled and i.asset_class = 'CRYPTO'
       order by i.canonical`;
    return rows.map(toDto);
  }

  async get(id: string): Promise<InstrumentDto | undefined> {
    const [row] = await this.db()<InstrumentRowDb[]>`
      select i.id, i.canonical, i.venue_id, i.market_type, i.display, i.base, i.quote, i.price_precision,
             i.tick_size, l.effective_class
        from instruments i
        join venues v on v.id = i.venue_id
        join instrument_license l on l.instrument_id = i.id
       where i.id = ${id} and i.active and v.enabled and v.analysis_enabled and i.asset_class = 'CRYPTO'`;
    return row ? toDto(row) : undefined;
  }

  /** Effective licence for one instrument, straight from the view. */
  async effectiveLicense(id: string): Promise<LicenseClass | undefined> {
    const [row] = await this.db()<{ effective_class: LicenseClass }[]>`
      select effective_class from instrument_license where instrument_id = ${id}`;
    return row?.effective_class;
  }

  async resolve(
    query: ResolveQuery,
  ): Promise<{ result: ResolveResult; dtos: Map<string, InstrumentDto> }> {
    const db = this.db();
    const keys = await db<{ key: string; instrument_id: string; weight: number }[]>`
      select key, instrument_id, weight from symbol_search_keys`;
    const searchKeys: SearchKey[] = keys.map((k) => ({
      key: k.key,
      instrumentId: k.instrument_id,
      weight: k.weight,
    }));
    const listed = await this.list();
    const prices = await db<{ instrument_id: string; c: string }[]>`
      select distinct on (instrument_id) instrument_id, c from candles
       where tf = '1m' and open_time > now() - interval '1 day'
       order by instrument_id, open_time desc`;
    const priceOf = new Map(prices.map((p) => [p.instrument_id, Number(p.c)]));
    const instruments = new Map<string, ResolvableInstrument>(
      listed.map((i) => [
        i.id,
        {
          id: i.id,
          canonical: i.canonical,
          venue: i.venue,
          marketType: i.marketType,
          display: i.display,
          lastPrice: priceOf.get(i.id),
        },
      ]),
    );
    return {
      result: resolveInstrument(query, searchKeys, instruments),
      dtos: new Map(listed.map((i) => [i.id, i])),
    };
  }

  /** Raw candles. Callers must have checked the licence; this method does not decide it. */
  async candles(id: string, tf: Timeframe, limit: number, before?: Date): Promise<CandleDto[]> {
    const rows = await this.db()<
      {
        open_time: Date;
        o: string;
        h: string;
        l: string;
        c: string;
        v: string | null;
        status: 'CLOSED' | 'INCOMPLETE';
      }[]
    >`select open_time, o, h, l, c, v, status from candles
       where instrument_id = ${id} and tf = ${tf} and scope_id = '00000000-0000-0000-0000-000000000000'
         ${before ? this.db()`and open_time < ${before}` : this.db()``}
       order by open_time desc limit ${limit}`;
    return rows
      .map((r) => ({
        openTime: r.open_time.toISOString(),
        o: Number(r.o),
        h: Number(r.h),
        l: Number(r.l),
        c: Number(r.c),
        v: r.v === null ? 0 : Number(r.v),
        status: r.status,
      }))
      .reverse();
  }

  async recordVenueTerms(
    venueId: string,
    input: {
      url: string;
      retrievedAt: string;
      summary: string;
      decision: string;
      reviewer: string;
      counselReviewed: boolean;
    },
    actor: { userId: string; ip: string | null },
  ): Promise<string | undefined> {
    const db = this.db();
    return db.begin(async (tx) => {
      const [venue] = await tx`select id from venues where id = ${venueId}`;
      if (!venue) return undefined;
      const [row] = await tx<{ id: string }[]>`
        insert into venue_terms (venue_id, url, retrieved_at, summary, decision, reviewer, counsel_reviewed)
        values (${venueId}, ${input.url}, ${input.retrievedAt}, ${input.summary}, ${input.decision},
                ${input.reviewer}, ${input.counselReviewed})
        returning id`;
      await tx`
        insert into audit_log (actor_id, action, target, ip, detail)
        values (${actor.userId}, 'admin.venue_terms', ${venueId}, ${actor.ip}, ${tx.json({ decision: input.decision, url: input.url })})`;
      return row?.id;
    });
  }

  async patchVenue(
    venueId: string,
    patch: { enabled?: boolean; analysisEnabled?: boolean; crosscheckEnabled?: boolean },
    actor: { userId: string; ip: string | null },
  ): Promise<boolean> {
    const db = this.db();
    return db.begin(async (tx) => {
      const rows = await tx`
        update venues set
          enabled = coalesce(${patch.enabled ?? null}, enabled),
          analysis_enabled = coalesce(${patch.analysisEnabled ?? null}, analysis_enabled),
          crosscheck_enabled = coalesce(${patch.crosscheckEnabled ?? null}, crosscheck_enabled)
        where id = ${venueId} returning id`;
      if (rows.length === 0) return false;
      await tx`
        insert into audit_log (actor_id, action, target, ip, detail)
        values (${actor.userId}, 'admin.venue_patch', ${venueId}, ${actor.ip}, ${tx.json(patch as never)})`;
      return true;
    });
  }
}
