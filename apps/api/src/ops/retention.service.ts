import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import { ENV, SQL } from '../config/tokens.js';

/** The engine replays at most the newest 3,000 candles per timeframe on a cold start; this keeps a little more. */
export const CANDLES_KEPT_PER_SERIES = 3_500;
/** Engine events feed the Changes tab and rebuild bookkeeping; nothing reads them past a month. */
export const ENGINE_EVENT_DAYS = 30;

/**
 * Keeps market data to what the engine can use. Candles beyond the newest N per market and timeframe are never read
 * again (a cold start replays 3,000), and old engine events are only history. Without this the tables grow with every
 * minute the feed runs and a small hosted database fills up. Returns how many rows went.
 */
export async function trimMarketData(
  sql: Sql,
  opts: { candlesKept?: number; eventDays?: number } = {},
): Promise<{ candles: number; engine_events: number }> {
  const kept = opts.candlesKept ?? CANDLES_KEPT_PER_SERIES;
  const days = opts.eventDays ?? ENGINE_EVENT_DAYS;
  const candles = await sql`
    with cut as (
      select instrument_id, tf, scope_id, (array_agg(open_time order by open_time desc))[${kept}] as cutoff
        from candles
       group by instrument_id, tf, scope_id
      having count(*) >= ${kept}
    )
    delete from candles c using cut
     where c.instrument_id = cut.instrument_id and c.tf = cut.tf and c.scope_id = cut.scope_id
       and c.open_time < cut.cutoff`;
  const events = await sql`
    delete from engine_events where event_time < now() - ${days} * interval '1 day'`;
  return { candles: candles.count, engine_events: events.count };
}

/**
 * Applies the retention promises (A06 section 10) on a timer: resume log 7 days, voice log 30 days, chat and Explain
 * records 90 days, AI call metadata 90 days (whole monthly partitions), audit trail one year, expired abuse blocks, old
 * idempotency keys and quarantined candles. The work is one SQL function (`retention_purge`), so it is also what a
 * database-only operator would run by hand.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (!this.sql || this.env.RETENTION_INTERVAL_MIN <= 0) return;
    const run = () =>
      this.run().catch((e: unknown) => this.log.error(`retention failed: ${String(e)}`));
    this.first = setTimeout(run, 60_000);
    this.timer = setInterval(run, this.env.RETENTION_INTERVAL_MIN * 60_000);
    this.first.unref();
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  /** Runs one pass and returns what was removed, by kind. */
  async run(): Promise<Record<string, unknown>> {
    if (!this.sql) return {};
    await this.sql`select maintain_partitions(3)`;
    const [row] = await this.sql<{ r: Record<string, unknown> }[]>`select retention_purge() as r`;
    const result = { ...(row?.r ?? {}), market_data: await trimMarketData(this.sql) };
    this.log.log(`retention pass: ${JSON.stringify(result)}`);
    return result;
  }
}
