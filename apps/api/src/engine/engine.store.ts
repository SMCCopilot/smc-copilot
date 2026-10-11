import type { StrategyConfig, Timeframe } from '@smc/contracts';
import { parseStrategyConfig } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { type EngineEvent, type EngineState, sha1 } from '@smc/smc-engine';

export interface ActiveStrategy {
  id: string;
  config: StrategyConfig;
}

export interface Snapshot {
  asOf: number;
  state: EngineState;
}

/** How a rebuild bounds what it may retract. */
export interface RebuildScope {
  /** Events after this time are re-derived (the snapshot's as_of, or 0 when there was none). */
  afterMs: number;
  /**
   * Timeframes replayed from a cold start, with the close time of the first candle replayed. Events older than
   * that were not re-derived, so they must never be retracted.
   */
  cold: Partial<Record<Timeframe, number>>;
  /** Snapshots after this time describe state that no longer exists and are deleted. */
  staleAfterMs: number;
}

const CHUNK = 400;
const HOURLY_KEPT = 12;
const DAILY_KEPT_DAYS = 7;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** SQL for strategy lookup, engine events and engine snapshots. Writes are idempotent on event_id / primary key. */
export class EngineStore {
  constructor(private readonly sql: Sql) {}

  async activeStrategy(): Promise<ActiveStrategy | null> {
    const [row] = await this.sql<{ id: string; config: unknown }[]>`
      select id, config from strategy_versions
       where name = 'smc-core' and status = 'ACTIVE'
       order by version desc limit 1`;
    return row ? { id: row.id, config: parseStrategyConfig(row.id, row.config) } : null;
  }

  async latestSnapshot(
    instrumentId: string,
    strategyId: string,
    atOrBeforeMs?: number,
  ): Promise<Snapshot | null> {
    const [row] = await this.sql<{ as_of: Date; state: EngineState }[]>`
      select as_of, state from engine_snapshots
       where instrument_id = ${instrumentId} and strategy_version_id = ${strategyId}
         ${atOrBeforeMs === undefined ? this.sql`` : this.sql`and as_of <= ${new Date(atOrBeforeMs)}`}
       order by as_of desc limit 1`;
    return row ? { asOf: row.as_of.getTime(), state: row.state } : null;
  }

  /**
   * One transaction: events (+ retraction of events that no longer exist after a rebuild), the snapshot and
   * snapshot retention. Returns how many events were new or revised.
   */
  async persist(
    instrumentId: string,
    strategyId: string,
    events: readonly EngineEvent[],
    snapshot: Snapshot | null,
    rebuild?: RebuildScope,
  ): Promise<{ written: number; retracted: number }> {
    return this.sql.begin(async (tx) => {
      let written = 0;
      const cols = [
        'event_id',
        'instrument_id',
        'strategy_version_id',
        'tf',
        'type',
        'anchor_time',
        'event_time',
        'confirmed_at',
        'payload',
      ] as const;
      for (let i = 0; i < events.length; i += CHUNK) {
        const rows = events.slice(i, i + CHUNK).map((e) => ({
          event_id: e.id,
          instrument_id: instrumentId,
          strategy_version_id: strategyId,
          tf: e.tf,
          type: e.type,
          anchor_time: new Date(e.anchorOpenTime),
          event_time: new Date(e.time),
          confirmed_at: new Date(e.time),
          payload: tx.json({ scale: e.scale, data: e.data } as never),
        }));
        const res = rebuild
          ? await tx`
              insert into engine_events ${tx(rows, ...cols)}
              on conflict (event_id) do update
                 set payload = excluded.payload, retracted = false, revision = engine_events.revision + 1
               where engine_events.payload is distinct from excluded.payload or engine_events.retracted
              returning event_id`
          : await tx`
              insert into engine_events ${tx(rows, ...cols)}
              on conflict (event_id) do nothing
              returning event_id`;
        written += res.length;
      }

      let retracted = 0;
      if (rebuild) {
        const keep = events.map((e) => e.id);
        const coldTfs = Object.keys(rebuild.cold);
        const base = await tx`
          update engine_events
             set retracted = true, revision = revision + 1
           where instrument_id = ${instrumentId} and strategy_version_id = ${strategyId}
             and event_time > ${new Date(rebuild.afterMs)} and not retracted
             and tf <> all(${coldTfs}::text[])
             and event_id <> all(${keep}::text[])
          returning event_id`;
        retracted += base.length;
        for (const [tf, firstClose] of Object.entries(rebuild.cold)) {
          const res = await tx`
            update engine_events
               set retracted = true, revision = revision + 1
             where instrument_id = ${instrumentId} and strategy_version_id = ${strategyId}
               and tf = ${tf} and event_time >= ${new Date(firstClose as number)} and not retracted
               and event_id <> all(${keep}::text[])
            returning event_id`;
          retracted += res.length;
        }
        await tx`
          delete from engine_snapshots
           where instrument_id = ${instrumentId} and strategy_version_id = ${strategyId}
             and as_of > ${new Date(rebuild.staleAfterMs)}`;
      }

      if (snapshot) {
        await tx`
          insert into engine_snapshots (instrument_id, strategy_version_id, as_of, state, state_hash)
          values (${instrumentId}, ${strategyId}, ${new Date(snapshot.asOf)},
                  ${tx.json(snapshot.state as never)}, ${sha1(JSON.stringify(snapshot.state))})
          on conflict (instrument_id, strategy_version_id, as_of) do nothing`;
        // Retention: the last 12 hourly snapshots plus one per UTC day for a week. A snapshot is ~250 KB.
        await tx`
          delete from engine_snapshots
           where instrument_id = ${instrumentId} and strategy_version_id = ${strategyId}
             and as_of < ${new Date(snapshot.asOf - HOURLY_KEPT * HOUR_MS)}
             and (as_of < ${new Date(snapshot.asOf - DAILY_KEPT_DAYS * DAY_MS)}
                  or (as_of at time zone 'UTC') <> date_trunc('day', as_of at time zone 'UTC'))`;
      }
      return { written, retracted };
    }) as Promise<{ written: number; retracted: number }>;
  }
}
