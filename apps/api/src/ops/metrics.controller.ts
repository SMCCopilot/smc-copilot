import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { LlmRouter } from '@smc/ai';
import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import { NarrativeService } from '../ai/narrative.service.js';
import { ENV, INGEST_RUNTIME, LLM_ROUTER, SQL } from '../config/tokens.js';
import type { IngestRuntime } from '../ingest/ingest.runtime.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { requestStats } from './request-stats.js';

const esc = (v: string): string =>
  v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ');

/** Prometheus text format. Names and labels only, never user data. */
class Out {
  private readonly lines: string[] = [];
  private seen = new Set<string>();
  g(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    if (!this.seen.has(name)) {
      this.seen.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    }
    const l = Object.entries(labels)
      .map(([k, v]) => `${k}="${esc(v)}"`)
      .join(',');
    this.lines.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(value) ? value : 0}`);
  }
  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/**
 * Operational metrics for the alert rules in `ops/alerts.yml` (A08 section 5.3). Protected by a bearer token because
 * it describes the system; without METRICS_TOKEN configured it does not exist.
 */
@Controller()
export class MetricsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SQL) private readonly sql: Sql | null,
    private readonly realtime: RealtimeService,
    private readonly narratives: NarrativeService,
    @Inject(LLM_ROUTER) private readonly router: LlmRouter,
    @Optional() @Inject(INGEST_RUNTIME) private readonly runtime: IngestRuntime | null,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async metrics(@Headers('authorization') auth?: string): Promise<string> {
    const token = this.env.METRICS_TOKEN;
    if (!token) throw new NotFoundException();
    const given = Buffer.from((auth ?? '').replace(/^Bearer /i, ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want))
      throw new UnauthorizedException();

    const o = new Out();
    o.g('smc_up', 'The API process is running.', 1);
    o.g('smc_process_uptime_seconds', 'Seconds since the process started.', process.uptime());
    o.g('smc_process_memory_rss_bytes', 'Resident memory.', process.memoryUsage().rss);

    for (const [cls, n] of Object.entries(requestStats.byClass)) {
      o.g('smc_http_requests_total', 'HTTP responses by status class since start.', n, {
        class: cls,
      });
    }
    o.g(
      'smc_http_request_seconds_total',
      'Total time spent answering requests since start.',
      requestStats.seconds,
    );
    const rt = this.realtime.stats();
    o.g('smc_realtime_sockets', 'Connected sockets.', rt.sockets);
    o.g('smc_realtime_sessions', 'Sessions held in memory.', rt.sessions);
    o.g('smc_realtime_reconnects_total', 'Reconnects since start.', rt.reconnects);
    o.g('smc_realtime_connects_total', 'Connections since start.', rt.connects);

    const now = Date.now();
    for (const f of this.runtime?.monitor?.all() ?? []) {
      o.g('smc_feed_ok', '1 when the feed is OK, 0 otherwise.', f.state === 'OK' ? 1 : 0, {
        instrument: f.canonical,
      });
      o.g('smc_feed_stale', '1 when the feed is STALE.', f.state === 'STALE' ? 1 : 0, {
        instrument: f.canonical,
      });
      if (f.lastClosedOpenMs !== null) {
        o.g(
          'smc_feed_candle_lag_seconds',
          'Seconds since the last closed 1m candle ended.',
          Math.max(0, (now - f.lastClosedOpenMs - 60_000) / 1000),
          { instrument: f.canonical },
        );
      }
    }

    for (const b of this.router.breakerStates()) {
      o.g(
        'smc_ai_breaker_open',
        '1 when the provider circuit breaker is open.',
        b.state === 'CLOSED' ? 0 : 1,
        { provider: b.provider, model: b.model },
      );
    }
    o.g(
      'smc_narrative_cache_hits_total',
      'Narrative cache hits since start.',
      this.narratives.stats.cacheHits,
    );
    o.g(
      'smc_narrative_generated_total',
      'Narratives generated since start.',
      this.narratives.stats.generated,
    );

    if (this.sql) {
      const t0 = Date.now();
      const [row] = await this.sql<
        {
          spent: string | null;
          cap: string | null;
          tripped: boolean;
          calls: number | null;
          sessions: number;
          flags: number;
          ahead: number;
          size: string;
          fb: number;
          unread: number;
        }[]
      >`
        select (select cost_usd from ai_global_ledger where day = (now() at time zone 'utc')::date) as spent,
               (select cap_usd from ai_global_ledger where day = (now() at time zone 'utc')::date) as cap,
               coalesce((select tripped_at is not null from ai_global_ledger where day = (now() at time zone 'utc')::date), false) as tripped,
               (select calls from ai_global_ledger where day = (now() at time zone 'utc')::date) as calls,
               (select count(*)::int from copilot_sessions where state <> 'ENDED') as sessions,
               (select count(*)::int from abuse_flags where expires_at > now()) as flags,
               (select count(*)::int from pg_class c join pg_inherits i on i.inhrelid = c.oid
                 where i.inhparent = 'candles'::regclass and c.relname > 'candles_' || to_char(date_trunc('month', now() + interval '1 month'), 'YYYY_MM')) as ahead,
               pg_database_size(current_database())::text as size,
               (select count(*)::int from user_feedback where created_at > now() - interval '1 day') as fb,
               (select count(*)::int from dq_incidents where closed_at is null) as unread`;
      o.g('smc_db_query_seconds', 'Time taken by the metrics query.', (Date.now() - t0) / 1000);
      o.g('smc_ai_spend_usd_today', 'Global AI spend today (UTC).', Number(row?.spent ?? 0));
      o.g(
        'smc_ai_cap_usd',
        'Global daily AI cap.',
        Number(row?.cap ?? this.env.AI_GLOBAL_DAILY_CAP_USD),
      );
      o.g(
        'smc_ai_cap_tripped',
        '1 when the global cap has switched AI off for today.',
        row?.tripped ? 1 : 0,
      );
      o.g('smc_ai_calls_today', 'Model calls today (UTC).', row?.calls ?? 0);
      o.g('smc_sessions_open', 'Open sessions in the database.', row?.sessions ?? 0);
      o.g('smc_abuse_flags_active', 'Active temporary blocks.', row?.flags ?? 0);
      o.g(
        'smc_candle_partitions_ahead',
        'Candle partitions that exist beyond next month.',
        row?.ahead ?? 0,
      );
      o.g('smc_db_size_bytes', 'Database size.', Number(row?.size ?? 0));
      o.g('smc_feedback_last_day', 'Feedback items in the last day.', row?.fb ?? 0);
      o.g('smc_dq_incidents_open', 'Open data-quality incidents.', row?.unread ?? 0);
    }
    return o.text();
  }
}
