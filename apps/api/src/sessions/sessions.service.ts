import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@smc/config';
import type { AnalysisResponse, Timeframe } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { FlagsService } from '../account/flags.service.js';
import { AnalysisService } from '../analysis/analysis.service.js';
import { ApiProblemError } from '../common/problem.js';
import { ENV, SQL } from '../config/tokens.js';
import { MarketsService } from '../markets/markets.service.js';
import { decodeCursor, encodeCursor } from '../setups/setups.service.js';
import { signWsToken } from './ws-token.js';

const MAX_SESSION_MINUTES = 240;
const STALE_SESSION_HOURS = 12;

interface SessionRow {
  id: string;
  instrument_id: string | null;
  tf: Timeframe | null;
  mode: 'FEED' | 'APPROX';
  state: 'CREATED' | 'ACTIVE' | 'PAUSED' | 'ENDED';
  started_at: Date;
  ended_at: Date | null;
  user_id: string;
  workspace_id: string;
}

const toDto = (r: SessionRow) => ({
  id: r.id,
  instrumentId: r.instrument_id,
  tf: r.tf,
  mode: r.mode,
  state: r.state,
  startedAt: r.started_at.toISOString(),
  endedAt: r.ended_at ? r.ended_at.toISOString() : null,
});

export interface SessionCreateInput {
  instrumentId?: string | undefined;
  tf?: Timeframe | undefined;
  mode: 'FEED' | 'APPROX';
  capture?: { surface: 'TAB' | 'WINDOW' | 'SCREEN' | 'NONE'; webgpu: boolean } | undefined;
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
    @Inject(ENV) private readonly env: Env,
    private readonly flags: FlagsService,
    private readonly markets: MarketsService,
    private readonly analysis: AnalysisService,
  ) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  private token(sessionId: string, userId: string): { token: string; expiresAt: string } {
    const secret = this.env.WS_TOKEN_SECRET;
    if (!secret) throw new ApiProblemError('NOT_READY', 'Realtime is not configured.');
    const { token, exp } = signWsToken(
      secret,
      { sid: sessionId, uid: userId },
      Math.floor(Date.now() / 1000),
    );
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  private async limitsOf(workspaceId: string) {
    const [e] = await this.sql<
      { limits: Record<string, number> }[]
    >`select limits from entitlements where workspace_id = ${workspaceId}`;
    const l = e?.limits ?? {};
    return {
      concurrent: l.concurrent_sessions ?? 1,
      out: {
        maxSessionMinutes: MAX_SESSION_MINUTES,
        dailyAiBudgetUsd: l.daily_ai_budget_usd ?? this.env.AI_DAILY_BUDGET_DEFAULT_USD,
        explainPerDay: l.explain_per_day ?? 3,
        voicePerDay: l.voice_per_day ?? 60,
      },
    };
  }

  async create(userId: string, workspaceId: string, input: SessionCreateInput, wsUrl: string) {
    if (await this.flags.killed('ALL_SESSIONS')) {
      throw new ApiProblemError('KILL_SWITCH_ACTIVE', 'New sessions are temporarily disabled.');
    }
    const lim = await this.limitsOf(workspaceId);

    // A session nobody ended must not lock the user out forever.
    await this.sql`
      update copilot_sessions set state = 'ENDED', ended_at = now(), end_reason = 'EXPIRED'
       where workspace_id = ${workspaceId} and state <> 'ENDED'
         and started_at < now() - ${STALE_SESSION_HOURS} * interval '1 hour'`;
    const [open] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from copilot_sessions where workspace_id = ${workspaceId} and state <> 'ENDED'`;
    if ((open?.n ?? 0) >= lim.concurrent) {
      throw new ApiProblemError(
        'SESSION_LIMIT_REACHED',
        'End your current session before starting another.',
      );
    }

    let instrumentId = input.instrumentId ?? null;
    if (instrumentId) {
      if (!(await this.markets.get(instrumentId))) {
        throw new ApiProblemError('INSTRUMENT_NOT_ENTITLED', 'That instrument is not available.');
      }
    } else {
      const [last] = await this.sql<{ instrument_id: string | null }[]>`
        select instrument_id from copilot_sessions
         where user_id = ${userId} and instrument_id is not null order by started_at desc limit 1`;
      instrumentId = last?.instrument_id ?? null;
    }
    const strategy = await this.analysis.activeStrategy();
    const [row] = await this.sql<{ id: string }[]>`
      insert into copilot_sessions (workspace_id, user_id, instrument_id, tf, strategy_version_id, mode, capture_surface, client_info)
      values (${workspaceId}, ${userId}, ${instrumentId}, ${input.tf ?? null}, ${strategy.id}, ${input.mode},
              ${input.capture?.surface ?? null}, ${this.sql.json({ webgpu: input.capture?.webgpu ?? false })})
      returning id`;
    const sessionId = (row as { id: string }).id;
    const { token, expiresAt } = this.token(sessionId, userId);

    let initial: AnalysisResponse | null = null;
    if (instrumentId) {
      try {
        initial = await this.analysis.snapshot(instrumentId, workspaceId, input.tf, new Set());
      } catch (e) {
        if (!(e instanceof ApiProblemError) || e.code !== 'ANALYSIS_UNAVAILABLE') throw e;
      }
    }
    return {
      sessionId,
      wsToken: token,
      wsTokenExpiresAt: expiresAt,
      wsUrl,
      limits: lim.out,
      initial,
    };
  }

  private async owned(id: string, userId: string): Promise<SessionRow> {
    const [r] = await this.sql<SessionRow[]>`
      select id, instrument_id, tf, mode, state, started_at, ended_at, user_id, workspace_id
        from copilot_sessions where id = ${id} and user_id = ${userId}`;
    if (!r) throw new ApiProblemError('NOT_FOUND');
    return r;
  }

  async get(id: string, userId: string) {
    return toDto(await this.owned(id, userId));
  }

  async list(userId: string, cursor: string | undefined, limit: number) {
    const cur = decodeCursor(cursor);
    const rows = await this.sql<SessionRow[]>`
      select id, instrument_id, tf, mode, state, started_at, ended_at, user_id, workspace_id
        from copilot_sessions
       where user_id = ${userId} ${cur ? this.sql`and (started_at, id) < (${cur.at}, ${cur.id})` : this.sql``}
       order by started_at desc, id desc limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor: rows.length > limit && last ? encodeCursor(last.started_at, last.id) : null,
    };
  }

  async refreshToken(id: string, userId: string) {
    const r = await this.owned(id, userId);
    if (r.state === 'ENDED')
      throw new ApiProblemError('SESSION_NOT_ACTIVE', 'That session has ended.');
    const { token, expiresAt } = this.token(id, userId);
    return { wsToken: token, wsTokenExpiresAt: expiresAt };
  }

  async end(id: string, userId: string, reason = 'USER'): Promise<void> {
    await this.owned(id, userId);
    await this.sql`
      update copilot_sessions set state = 'ENDED', ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, ${reason})
       where id = ${id} and state <> 'ENDED'`;
  }
}
