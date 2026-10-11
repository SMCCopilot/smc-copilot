import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { liquidationPrice } from '@smc/analytics';
import type { Sql } from '@smc/db';
import { EVENT_BUS, INGEST_RUNTIME, SQL } from '../config/tokens.js';
import type { EventBus } from '../ingest/event-bus.js';
import type { IngestRuntime } from '../ingest/ingest.runtime.js';
import { NotificationsService } from '../journal/notifications.service.js';

export const POSITION_EVENT_TYPES = [
  'near_stop',
  'near_target',
  'tp_hit',
  'sl_hit',
  'thesis_degraded',
  'invalidated',
  'stale_data',
  'liquidation_risk',
] as const;
export type PositionEventType = (typeof POSITION_EVENT_TYPES)[number];

/** A position is "near" a level inside this fraction of the entry-to-level distance. */
export const NEAR_FRACTION = 0.2;

export interface WatchedTrade {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number | null;
  targets: readonly number[];
  leverage: number | null;
  /** State of the setup the trade followed, when it followed one. */
  setupState: string | null;
  feedStale: boolean;
}
export interface Bar {
  h: number;
  l: number;
  c: number;
}

/**
 * Pure: which monitor events hold for a trade at the latest closed bar. Facts about the position against its own
 * levels; never advice to close, add or move anything.
 */
export function evaluatePosition(t: WatchedTrade, bar: Bar): PositionEventType[] {
  const out: PositionEventType[] = [];
  const long = t.direction === 'LONG';
  // For a LONG a stop is below (touched when low reaches it) and a target above (high reaches it); mirrored for a SHORT.
  const stopHit = t.stop !== null && (long ? bar.l <= t.stop : bar.h >= t.stop);
  const targetHit = t.targets.some((x) => (long ? bar.h >= x : bar.l <= x));
  if (stopHit) out.push('sl_hit');
  if (targetHit) out.push('tp_hit');

  if (!stopHit && t.stop !== null) {
    const dist = Math.abs(t.entry - t.stop);
    if (dist > 0 && Math.abs(bar.c - t.stop) <= NEAR_FRACTION * dist) out.push('near_stop');
  }
  const first = t.targets[0];
  if (!targetHit && first !== undefined) {
    const dist = Math.abs(first - t.entry);
    if (dist > 0 && Math.abs(first - bar.c) <= NEAR_FRACTION * dist) out.push('near_target');
  }
  if (t.leverage && t.leverage > 1) {
    const liq = liquidationPrice(t.direction, t.entry, t.leverage);
    const dist = Math.abs(t.entry - liq);
    if (dist > 0 && Math.abs(bar.c - liq) <= NEAR_FRACTION * dist) out.push('liquidation_risk');
  }
  if (t.setupState === 'INVALIDATED') out.push('invalidated');
  if (t.setupState === 'EXPIRED') out.push('thesis_degraded');
  if (t.feedStale) out.push('stale_data');
  return out;
}

interface OpenRow {
  id: string;
  workspace_id: string;
  user_id: string;
  direction: 'LONG' | 'SHORT';
  leverage: string | null;
  stop_price: string | null;
  targets: string[] | null;
  entry_price: string | null;
  opened_at: Date;
  setup_state: string | null;
}

/** Watches open trades after each engine update and writes each event type at most once per trade. */
@Injectable()
export class PositionMonitor implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void)[] = [];
  /** Realtime hook so the open session sees the event as `position.event`. */
  onEvent:
    | ((
        workspaceId: string,
        userId: string,
        e: { tradeId: string; type: PositionEventType },
      ) => void)
    | null = null;

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    private readonly notifications: NotificationsService,
    @Optional() @Inject(EVENT_BUS) private readonly bus: EventBus | null,
    @Optional() @Inject(INGEST_RUNTIME) private readonly runtime: IngestRuntime | null,
  ) {}

  onModuleInit(): void {
    if (!this.bus || !this.sql) return;
    this.unsubscribe.push(
      this.bus.subscribe('engine.updated', async (e) => {
        await this.check(e.instrumentId);
      }),
      this.bus.subscribe('feed.status', async (e) => {
        await this.check(e.instrumentId);
      }),
    );
  }
  onModuleDestroy(): void {
    for (const u of this.unsubscribe) u();
  }

  async check(instrumentId: string): Promise<number> {
    if (!this.sql) return 0;
    const rows = await this.sql<OpenRow[]>`
      select t.id, t.workspace_id, t.user_id, t.opened_at, t.direction, t.leverage, t.stop_price, t.targets,
             (select price from trade_fills f where f.trade_id = t.id and f.side = 'ENTRY' order by f.id limit 1) as entry_price,
             (select s.state from setups s where s.id = t.setup_id) as setup_state
        from trade_records t where t.instrument_id = ${instrumentId} and t.status = 'OPEN'`;
    if (rows.length === 0) return 0;
    const [bar] = await this.sql<{ h: string; l: string; c: string }[]>`
      select h, l, c from candles
       where instrument_id = ${instrumentId} and tf = '1m' and status = 'CLOSED'
         and scope_id = '00000000-0000-0000-0000-000000000000'
       order by open_time desc limit 1`;
    if (!bar) return 0;
    const stale = this.runtime?.monitor?.statusOf(instrumentId)?.state === 'STALE';
    let written = 0;
    for (const r of rows) {
      if (r.entry_price === null) continue;
      // Only bars that opened after the entry count: an earlier wick happened before the user was in.
      const [since] = await this.sql<{ h: string | null; l: string | null }[]>`
        select max(h) as h, min(l) as l from candles
         where instrument_id = ${instrumentId} and tf = '1m' and status = 'CLOSED'
           and scope_id = '00000000-0000-0000-0000-000000000000' and open_time >= ${r.opened_at}`;
      const close = Number(bar.c);
      const range = {
        h: since?.h == null ? close : Number(since.h),
        l: since?.l == null ? close : Number(since.l),
      };
      const found = evaluatePosition(
        {
          direction: r.direction,
          entry: Number(r.entry_price),
          stop: r.stop_price === null ? null : Number(r.stop_price),
          targets: (r.targets ?? []).map(Number),
          leverage: r.leverage === null ? null : Number(r.leverage),
          setupState: r.setup_state,
          feedStale: stale,
        },
        { h: range.h, l: range.l, c: close },
      );
      for (const type of found) {
        const [ins] = await this.sql`
          insert into position_events (trade_id, type, payload)
          select ${r.id}, ${type}, ${this.sql.json({ close: Number(bar.c) })}
           where not exists (select 1 from position_events where trade_id = ${r.id} and type = ${type})
          returning id`;
        if (!ins) continue;
        written++;
        await this.notifications.create(r.workspace_id, r.user_id, `position.${type}`, {
          tradeId: r.id,
          type,
        });
        this.onEvent?.(r.workspace_id, r.user_id, { tradeId: r.id, type });
      }
    }
    return written;
  }
}
