import type { Timeframe } from '@smc/contracts';
import type { Sql } from '@smc/db';
import type { QuarantineReason, StoredCandle } from '@smc/market-data';

type Tx = Sql;

interface CandleRow {
  open_time: Date;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  flags: number;
  status: 'CLOSED' | 'INCOMPLETE';
  provider_id: string;
}

const toStored = (instrumentId: string, tf: Timeframe, r: CandleRow): StoredCandle => ({
  instrumentId,
  tf,
  openTime: r.open_time.getTime(),
  o: Number(r.o),
  h: Number(r.h),
  l: Number(r.l),
  c: Number(r.c),
  v: r.v === null ? 0 : Number(r.v),
  closed: r.status === 'CLOSED',
  providerId: r.provider_id,
  flags: r.flags,
  status: r.status,
});

/** SQL for candles, quarantine, gaps and incidents. Every write is idempotent on the candle primary key. */
export class CandleStore {
  constructor(private readonly sql: Sql) {}

  begin<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => work(tx as unknown as Tx)) as Promise<T>;
  }

  async get(
    instrumentId: string,
    tf: Timeframe,
    openTime: number,
    db: Tx = this.sql,
  ): Promise<StoredCandle | undefined> {
    const [row] = await db<CandleRow[]>`
      select open_time, o, h, l, c, v, flags, status, provider_id from candles
       where instrument_id = ${instrumentId} and tf = ${tf} and open_time = ${new Date(openTime)}
         and scope_id = '00000000-0000-0000-0000-000000000000'`;
    return row ? toStored(instrumentId, tf, row) : undefined;
  }

  async range(
    instrumentId: string,
    tf: Timeframe,
    fromMs: number,
    toMs: number,
    db: Tx = this.sql,
  ): Promise<StoredCandle[]> {
    const rows = await db<CandleRow[]>`
      select open_time, o, h, l, c, v, flags, status, provider_id from candles
       where instrument_id = ${instrumentId} and tf = ${tf}
         and scope_id = '00000000-0000-0000-0000-000000000000'
         and open_time >= ${new Date(fromMs)} and open_time < ${new Date(toMs)}
       order by open_time`;
    return rows.map((r) => toStored(instrumentId, tf, r));
  }

  async latestOpenTime(instrumentId: string, tf: Timeframe): Promise<number | null> {
    const [row] = await this.sql<{ t: Date | null }[]>`
      select max(open_time) as t from candles
       where instrument_id = ${instrumentId} and tf = ${tf}
         and scope_id = '00000000-0000-0000-0000-000000000000'`;
    return row?.t ? row.t.getTime() : null;
  }

  /** Inserts a 1m candle. Returns false when the key already exists (a harmless repeat). */
  async insert1m(c: StoredCandle, db: Tx): Promise<boolean> {
    const rows = await db`
      insert into candles (instrument_id, tf, open_time, o, h, l, c, v, provider_id, status, flags)
      values (${c.instrumentId}, '1m', ${new Date(c.openTime)}, ${c.o}, ${c.h}, ${c.l}, ${c.c}, ${c.v},
              ${c.providerId}, ${c.status}, ${c.flags})
      on conflict (instrument_id, tf, scope_id, open_time) do nothing
      returning 1`;
    return rows.length > 0;
  }

  /**
   * Writes a higher-timeframe candle. A CLOSED candle replaces an INCOMPLETE one (a backfill completed it);
   * a CLOSED candle is never overwritten. Returns what happened.
   */
  async upsertHtf(c: StoredCandle, db: Tx): Promise<'inserted' | 'upgraded' | 'unchanged'> {
    // System columns (xmax) are not available on partitioned tables, so insert and upgrade are two statements.
    const inserted = await db`
      insert into candles (instrument_id, tf, open_time, o, h, l, c, v, provider_id, status, flags)
      values (${c.instrumentId}, ${c.tf}, ${new Date(c.openTime)}, ${c.o}, ${c.h}, ${c.l}, ${c.c}, ${c.v},
              ${c.providerId}, ${c.status}, ${c.flags})
      on conflict (instrument_id, tf, scope_id, open_time) do nothing
      returning 1`;
    if (inserted.length > 0) return 'inserted';
    const upgraded = await db`
      update candles
         set o = ${c.o}, h = ${c.h}, l = ${c.l}, c = ${c.c}, v = ${c.v}, provider_id = ${c.providerId},
             status = ${c.status}, flags = ${c.flags}, ingested_at = now()
       where instrument_id = ${c.instrumentId} and tf = ${c.tf} and open_time = ${new Date(c.openTime)}
         and scope_id = '00000000-0000-0000-0000-000000000000' and status = 'INCOMPLETE'
      returning 1`;
    return upgraded.length > 0 ? 'upgraded' : 'unchanged';
  }

  async orFlags(
    instrumentId: string,
    tf: Timeframe,
    openTime: number,
    flags: number,
  ): Promise<void> {
    await this.sql`
      update candles set flags = flags | ${flags}
       where instrument_id = ${instrumentId} and tf = ${tf} and open_time = ${new Date(openTime)}
         and scope_id = '00000000-0000-0000-0000-000000000000'`;
  }

  async quarantine(
    instrumentId: string | null,
    providerId: string,
    reason: QuarantineReason,
    raw: unknown,
  ): Promise<void> {
    await this.sql`
      insert into candle_quarantine (instrument_id, provider_id, reason, raw)
      values (${instrumentId}, ${providerId}, ${reason}, ${this.sql.json(raw as never)})`;
  }

  async recordGap(
    instrumentId: string,
    tf: Timeframe,
    fromMs: number,
    toMs: number,
  ): Promise<void> {
    await this.sql`
      insert into candle_gaps (instrument_id, tf, from_time, to_time)
      values (${instrumentId}, ${tf}, ${new Date(fromMs)}, ${new Date(toMs)})
      on conflict (instrument_id, tf, from_time, to_time) do nothing`;
  }

  async setGapStatus(
    instrumentId: string,
    fromMs: number,
    toMs: number,
    status: 'BACKFILLING' | 'RESOLVED' | 'UNRESOLVABLE',
  ): Promise<void> {
    await this.sql`
      update candle_gaps
         set status = ${status}, resolved_at = ${status === 'BACKFILLING' ? null : new Date()}
       where instrument_id = ${instrumentId} and tf = '1m'
         and from_time = ${new Date(fromMs)} and to_time = ${new Date(toMs)}`;
  }

  async openGaps(
    instrumentId?: string,
  ): Promise<{ instrumentId: string; fromMs: number; toMs: number }[]> {
    const rows = await this.sql<{ instrument_id: string; from_time: Date; to_time: Date }[]>`
      select instrument_id, from_time, to_time from candle_gaps
       where status in ('OPEN', 'BACKFILLING')
         ${instrumentId ? this.sql`and instrument_id = ${instrumentId}` : this.sql``}
       order by from_time`;
    return rows.map((r) => ({
      instrumentId: r.instrument_id,
      fromMs: r.from_time.getTime(),
      toMs: r.to_time.getTime(),
    }));
  }

  /** Opens an incident unless one is already open for this instrument and rule. Returns true when newly opened. */
  async openIncident(
    instrumentId: string,
    venueId: string,
    rule: string,
    details: unknown,
  ): Promise<boolean> {
    const rows = await this.sql`
      insert into dq_incidents (instrument_id, venue_id, rule, details)
      select ${instrumentId}, ${venueId}, ${rule}, ${this.sql.json(details as never)}
       where not exists (select 1 from dq_incidents
                          where instrument_id = ${instrumentId} and rule = ${rule} and closed_at is null)
      returning id`;
    return rows.length > 0;
  }

  async closeIncident(instrumentId: string, rule: string): Promise<boolean> {
    const rows = await this.sql`
      update dq_incidents set closed_at = now()
       where instrument_id = ${instrumentId} and rule = ${rule} and closed_at is null
      returning id`;
    return rows.length > 0;
  }

  async hasOpenIncident(instrumentId: string): Promise<boolean> {
    const [row] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from dq_incidents where instrument_id = ${instrumentId} and closed_at is null`;
    return (row?.n ?? 0) > 0;
  }
}
