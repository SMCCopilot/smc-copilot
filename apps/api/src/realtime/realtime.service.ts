import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Env } from '@smc/config';
import {
  CLIENT_EVENT_TYPES,
  ClientEventSchemas,
  type ClientEventType,
  type ErrorCode,
  RESERVED_CLIENT_EVENTS,
  type Timeframe,
} from '@smc/contracts';
import type { Sql } from '@smc/db';
import { Server, type Socket } from 'socket.io';
import { AnalysisService } from '../analysis/analysis.service.js';
import { ApiProblemError } from '../common/problem.js';
import { ENV, EVENT_BUS, SQL } from '../config/tokens.js';
import { GateService, type GateStateDto } from '../gate/gate.service.js';
import type { EventBus } from '../ingest/event-bus.js';
import { type NotificationDto, NotificationsService } from '../journal/notifications.service.js';
import { MarketsService } from '../markets/markets.service.js';
import { verifyWsToken } from '../sessions/ws-token.js';
import { SetupsService } from '../setups/setups.service.js';
import { PositionMonitor } from '../trades/position-monitor.js';

/** Past this many queued packets a socket is slow: pushes are skipped and the client resyncs from `seq` (A02 section 4). */
const BACKPRESSURE_PACKETS = 100;
const MAX_SESSION_MS = 240 * 60_000;
const REPLAY_LIMIT = 500;
/** Large payloads are not stored in the resume log; a resume sends a fresh snapshot instead. */
const COMPACT_TYPES = new Set(['analysis.update']);

interface Ctx {
  sessionId: string;
  userId: string;
  workspaceId: string;
  startedAt: number;
  instrumentId: string | null;
  canonical: string | null;
  tf: Timeframe | null;
  seq: number;
  socketId: string | null;
  lastSnapshotId: string | null;
  seen: Map<string, string>;
  dirty: boolean;
}

export interface Envelope {
  seq: number;
  type: string;
  at: number;
  correlationId: string;
  payload: unknown;
}

/**
 * The realtime channel (B04 section 3, A02 section 4): one socket per session, authenticated by the short-lived wsToken,
 * one controller at a time, every event numbered and logged so a reconnect resumes where it left off. The channel
 * carries analysis out; it has no event that confirms a gate or logs a trade.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Realtime');
  private io: Server | null = null;
  private readonly sessions = new Map<string, Ctx>();
  private unsub: (() => void)[] = [];
  private reaper: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: HttpAdapterHost,
    @Inject(ENV) private readonly env: Env,
    @Inject(SQL) private readonly sql: Sql | null,
    private readonly analysis: AnalysisService,
    private readonly setups: SetupsService,
    private readonly markets: MarketsService,
    private readonly gate: GateService,
    private readonly notifications: NotificationsService,
    private readonly positions: PositionMonitor,
    @Optional() @Inject(EVENT_BUS) private readonly bus: EventBus | null,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.host.httpAdapter?.getHttpServer();
    if (!server || !this.sql || !this.env.WS_TOKEN_SECRET) return;
    this.io = new Server(server as never, {
      path: '/ws',
      serveClient: false,
      maxHttpBufferSize: 64 * 1024,
      // An empty list allows no cross-origin browser; same-origin pages (the dev client) are unaffected.
      cors: { origin: [...this.env.CORS_ORIGINS] },
    });
    this.io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (e: unknown) =>
          next(Object.assign(new Error(e instanceof ApiProblemError ? e.code : 'AUTH_REQUIRED'))),
      );
    });
    this.io.on('connection', (socket) => this.onConnection(socket));

    this.gate.onState = (_w, userId, g) =>
      this.toUser(userId, 'gate.state', g satisfies GateStateDto);
    this.notifications.onCreated = (_w, userId, n) =>
      this.toUser(userId, 'notification', n satisfies NotificationDto);
    this.positions.onEvent = (_w, userId, e) => this.toUser(userId, 'position.event', e);
    if (this.bus) {
      this.unsub.push(
        this.bus.subscribe('engine.updated', (e) => this.pushAnalysis(e.instrumentId)),
        this.bus.subscribe('feed.status', (e) => {
          for (const c of this.inRoom(e.instrumentId)) {
            this.emit(c, 'feed.status', {
              canonical: e.canonical,
              state: e.state,
              reasons: e.reasons,
            });
            if (e.state === 'STALE') this.emit(c, 'warning', { code: 'FEED_STALE' });
          }
        }),
      );
    }
    this.reaper = setInterval(() => void this.reap(), 60_000);
    this.reaper.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    for (const u of this.unsub) u();
    if (this.reaper) clearInterval(this.reaper);
    this.gate.onState = null;
    this.notifications.onCreated = null;
    this.positions.onEvent = null;
    await new Promise<void>((resolve) => {
      if (!this.io) return resolve();
      this.io.close(() => resolve());
    });
  }

  // ---- connection

  private async authenticate(socket: Socket): Promise<void> {
    const raw: unknown = socket.handshake.auth?.wsToken;
    const secret = this.env.WS_TOKEN_SECRET;
    const claims =
      typeof raw === 'string' && secret
        ? verifyWsToken(secret, raw, Math.floor(Date.now() / 1000))
        : null;
    if (!claims) throw new ApiProblemError('AUTH_REQUIRED');
    const [s] = await (this.sql as Sql)<
      {
        id: string;
        workspace_id: string;
        instrument_id: string | null;
        canonical: string | null;
        tf: Timeframe | null;
        started_at: Date;
      }[]
    >`
      select s.id, s.workspace_id, s.instrument_id, i.canonical, s.tf, s.started_at
        from copilot_sessions s left join instruments i on i.id = s.instrument_id
       where s.id = ${claims.sid} and s.user_id = ${claims.uid} and s.state <> 'ENDED'`;
    if (!s) throw new ApiProblemError('SESSION_NOT_ACTIVE');
    socket.data.ctx = {
      sessionId: s.id,
      userId: claims.uid,
      workspaceId: s.workspace_id,
      startedAt: s.started_at.getTime(),
      instrumentId: s.instrument_id,
      canonical: s.canonical,
      tf: s.tf,
    };
  }

  private onConnection(socket: Socket): void {
    const base = socket.data.ctx as Pick<
      Ctx,
      'sessionId' | 'userId' | 'workspaceId' | 'startedAt' | 'instrumentId' | 'canonical' | 'tf'
    >;
    const existing = this.sessions.get(base.sessionId);
    const takeover = socket.handshake.auth?.takeover === true;
    if (existing?.socketId && this.io?.sockets.sockets.has(existing.socketId)) {
      if (!takeover) {
        socket.emit('error', {
          code: 'SESSION_CONTROLLER_TAKEN',
          detail: 'Another tab controls this session.',
        });
        socket.disconnect(true);
        return;
      }
      const old = this.io.sockets.sockets.get(existing.socketId);
      old?.emit('error', {
        code: 'SESSION_CONTROLLER_TAKEN',
        detail: 'Another tab took over this session.',
      });
      old?.disconnect(true);
    }
    // Everything up to registering the handlers is synchronous: a client may emit the moment it connects.
    const isNew = !existing;
    const ctx: Ctx = existing ?? {
      ...base,
      seq: 0,
      socketId: null,
      lastSnapshotId: null,
      seen: new Map(),
      dirty: false,
    };
    ctx.socketId = socket.id;
    this.sessions.set(ctx.sessionId, ctx);
    const sql = this.sql as Sql;
    let queue: Promise<void> = (async () => {
      if (isNew) {
        const [m] = await sql<{ m: string }[]>`
          select coalesce(max(seq), 0)::text as m from session_events where session_id = ${ctx.sessionId}`;
        ctx.seq = Number(m?.m ?? 0);
      }
      await socket.join(`session:${ctx.sessionId}`);
      if (ctx.instrumentId) await socket.join(`inst:${ctx.instrumentId}`);
    })().catch((e: unknown) => this.fail(ctx, e));
    // One event at a time per session, in arrival order.
    const enqueue = (work: () => Promise<void> | void): void => {
      queue = queue.then(work).catch((e: unknown) => this.fail(ctx, e));
    };

    for (const type of CLIENT_EVENT_TYPES) {
      socket.on(type, (raw: unknown) => enqueue(() => this.handle(socket, ctx, type, raw)));
    }
    for (const type of RESERVED_CLIENT_EVENTS) {
      socket.on(type, () =>
        enqueue(() => {
          this.emit(ctx, 'error', { code: 'STT_UNAVAILABLE', detail: 'Not available yet.' });
        }),
      );
    }
    socket.on('disconnect', () => {
      if (ctx.socketId === socket.id) ctx.socketId = null;
    });
  }

  // ---- inbound

  private async handle(
    socket: Socket,
    ctx: Ctx,
    type: ClientEventType,
    raw: unknown,
  ): Promise<void> {
    const parsed = ClientEventSchemas[type].safeParse(raw ?? {});
    if (!parsed.success) {
      this.emit(ctx, 'error', { code: 'VALIDATION_FAILED', detail: `Invalid ${type} payload.` });
      return;
    }
    const p = parsed.data as Record<string, unknown>;
    switch (type) {
      case 'session.start': {
        if (p.sessionId !== ctx.sessionId) {
          this.emit(ctx, 'error', {
            code: 'FORBIDDEN',
            detail: "That is not this socket's session.",
          });
          return;
        }
        if (p.instrumentId)
          await this.setContext(
            socket,
            ctx,
            p.instrumentId as string,
            (p.tf as Timeframe) ?? ctx.tf,
          );
        else if (p.tf) ctx.tf = p.tf as Timeframe;
        await (this
          .sql as Sql)`update copilot_sessions set state = 'ACTIVE' where id = ${ctx.sessionId} and state in ('CREATED','PAUSED')`;
        if (typeof p.lastSeq === 'number') await this.replay(ctx, p.lastSeq);
        this.emit(ctx, 'session.state', {
          state: 'ACTIVE',
          sessionId: ctx.sessionId,
          instrumentId: ctx.canonical,
          tf: ctx.tf,
          resumedFrom: typeof p.lastSeq === 'number' ? p.lastSeq : null,
        });
        await this.pushAnalysis(ctx.instrumentId, ctx);
        return;
      }
      case 'session.pause':
        await (this
          .sql as Sql)`update copilot_sessions set state = 'PAUSED' where id = ${ctx.sessionId} and state = 'ACTIVE'`;
        this.emit(ctx, 'session.state', { state: 'PAUSED', sessionId: ctx.sessionId });
        return;
      case 'session.end':
        await this.endSession(ctx, 'USER');
        return;
      case 'context.set':
        await this.setContext(socket, ctx, p.instrumentId as string, p.tf as Timeframe);
        await this.pushAnalysis(ctx.instrumentId, ctx);
        return;
      case 'analysis.request':
        ctx.lastSnapshotId = null;
        await this.pushAnalysis(ctx.instrumentId, ctx);
        return;
      case 'setup.watch':
      case 'context.hint':
        return;
      default:
        // explain, chat and voice need the AI layer, which is off until Phase 5.
        this.emit(ctx, 'error', {
          code: 'AI_TEMPORARILY_UNAVAILABLE',
          detail: 'AI features are not enabled yet.',
        });
    }
  }

  private async setContext(
    socket: Socket,
    ctx: Ctx,
    canonical: string,
    tf: Timeframe | null,
  ): Promise<void> {
    const [row] = await (this.sql as Sql)<
      { id: string }[]
    >`select id from instruments where canonical = ${canonical}`;
    const inst = row ? await this.markets.get(row.id) : undefined;
    if (!inst) {
      this.emit(ctx, 'error', {
        code: 'INSTRUMENT_NOT_ENTITLED',
        detail: 'That instrument is not available.',
      });
      return;
    }
    if (ctx.instrumentId) await socket.leave(`inst:${ctx.instrumentId}`);
    ctx.instrumentId = inst.id;
    ctx.canonical = inst.canonical;
    ctx.tf = tf;
    ctx.lastSnapshotId = null;
    ctx.seen.clear();
    await socket.join(`inst:${inst.id}`);
    await (this
      .sql as Sql)`update copilot_sessions set instrument_id = ${inst.id}, tf = ${tf} where id = ${ctx.sessionId}`;
    this.emit(ctx, 'context.updated', { instrumentId: inst.canonical, tf, source: 'manual' });
  }

  private async replay(ctx: Ctx, lastSeq: number): Promise<void> {
    const rows = await (this.sql as Sql)<
      { seq: string; type: string; payload: unknown; created_at: Date }[]
    >`
      select seq::text, type, payload, created_at from session_events
       where session_id = ${ctx.sessionId} and seq > ${lastSeq} order by seq limit ${REPLAY_LIMIT}`;
    const socket = this.socketOf(ctx);
    for (const r of rows) {
      socket?.emit(r.type, {
        seq: Number(r.seq),
        type: r.type,
        at: r.created_at.getTime(),
        correlationId: `replay-${r.seq}`,
        payload: r.payload,
        replayed: true,
      });
    }
  }

  // ---- outbound

  private socketOf(ctx: Ctx): Socket | undefined {
    return ctx.socketId ? this.io?.sockets.sockets.get(ctx.socketId) : undefined;
  }

  private inRoom(instrumentId: string): Ctx[] {
    return [...this.sessions.values()].filter((c) => c.instrumentId === instrumentId && c.socketId);
  }

  /** Numbers, logs and sends one event. The log keeps a compact form of large payloads (resume re-sends a snapshot). */
  emit(ctx: Ctx, type: string, payload: unknown): Envelope {
    ctx.seq += 1;
    const env: Envelope = {
      seq: ctx.seq,
      type,
      at: Date.now(),
      correlationId: randomUUID(),
      payload,
    };
    const stored = COMPACT_TYPES.has(type)
      ? { snapshotId: (payload as { snapshotId?: string }).snapshotId ?? null }
      : payload;
    if (this.sql) {
      this.sql`
        insert into session_events (session_id, seq, type, payload)
        values (${ctx.sessionId}, ${env.seq}, ${type}, ${this.sql.json(stored as never)})
        on conflict do nothing`.catch((e: unknown) =>
        this.log.warn(`session_events write failed: ${String(e)}`),
      );
    }
    const socket = this.socketOf(ctx);
    if (socket) {
      if (
        type === 'analysis.update' &&
        (socket.conn as unknown as { writeBuffer: unknown[] }).writeBuffer.length >
          BACKPRESSURE_PACKETS
      ) {
        ctx.dirty = true;
        ctx.lastSnapshotId = null;
      } else {
        socket.emit(type, env);
      }
    }
    return env;
  }

  private toUser(userId: string, type: string, payload: unknown): void {
    for (const c of this.sessions.values())
      if (c.userId === userId && c.socketId) this.emit(c, type, payload);
  }

  private fail(ctx: Ctx, e: unknown): void {
    const code: ErrorCode = e instanceof ApiProblemError ? e.code : 'INTERNAL';
    if (code === 'INTERNAL') this.log.error(`handler failed: ${String(e)}`);
    this.emit(ctx, 'error', {
      code,
      ...(e instanceof ApiProblemError && e.detail ? { detail: e.detail } : {}),
    });
  }

  /** Sends the snapshot (when it changed) and any setup changes to one session, or to every session on the instrument. */
  async pushAnalysis(instrumentId: string | null, only?: Ctx): Promise<void> {
    if (!instrumentId) return;
    const targets = only ? [only] : this.inRoom(instrumentId);
    for (const ctx of targets) {
      try {
        const snap = await this.analysis.snapshot(
          instrumentId,
          ctx.workspaceId,
          ctx.tf ?? undefined,
          new Set(),
        );
        if (snap.snapshotId !== ctx.lastSnapshotId) {
          ctx.lastSnapshotId = snap.snapshotId;
          this.emit(ctx, 'analysis.update', snap);
        }
        if (snap.dataQuality !== 'OK') this.emit(ctx, 'warning', { code: 'FEED_STALE' });
        await this.pushSetups(ctx, instrumentId);
      } catch (e) {
        if (e instanceof ApiProblemError && e.code === 'ANALYSIS_UNAVAILABLE') continue;
        this.log.warn(`push failed: ${String(e)}`);
      }
    }
  }

  private async pushSetups(ctx: Ctx, instrumentId: string): Promise<void> {
    const list = await this.setups.activeFor(instrumentId, ctx.workspaceId);
    for (const s of list) {
      const sig = `${s.state}:${s.updatedAt}`;
      const before = ctx.seen.get(s.id);
      if (before === sig) continue;
      ctx.seen.set(s.id, sig);
      this.emit(ctx, 'setup.event', { change: before ? 'UPDATED' : 'NEW', setup: s });
      if (s.state === 'ARMED' || s.state === 'TRIGGERED')
        await this.recordShown(ctx, s.id, s.state);
    }
  }

  /** What the user was actually shown is the journal's basis: one SETUP_SHOWN entry the first time. */
  private async recordShown(ctx: Ctx, setupId: string, state: string): Promise<void> {
    const sql = this.sql as Sql;
    const [ins] = await sql`
      insert into session_setup_views (session_id, setup_id, last_state) values (${ctx.sessionId}, ${setupId}, ${state})
      on conflict (session_id, setup_id) do update set last_state = excluded.last_state
      returning (xmax = 0) as inserted`;
    if (ins?.inserted) {
      await sql`
        insert into journal_entries (workspace_id, user_id, session_id, setup_id, kind, payload)
        values (${ctx.workspaceId}, ${ctx.userId}, ${ctx.sessionId}, ${setupId}, 'SETUP_SHOWN', ${sql.json({ state })})`;
    }
  }

  private async endSession(ctx: Ctx, reason: string): Promise<void> {
    await (this.sql as Sql)`
      update copilot_sessions set state = 'ENDED', ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, ${reason})
       where id = ${ctx.sessionId} and state <> 'ENDED'`;
    this.emit(ctx, 'session.state', { state: 'ENDED', sessionId: ctx.sessionId, reason });
    const socket = this.socketOf(ctx);
    this.sessions.delete(ctx.sessionId);
    socket?.disconnect(true);
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const c of [...this.sessions.values()]) {
      if (now - c.startedAt > MAX_SESSION_MS)
        await this.endSession(c, 'MAX_DURATION').catch(() => undefined);
    }
  }
}
