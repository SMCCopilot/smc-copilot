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
import { parseCommand } from '@smc/ai';
import type { Env } from '@smc/config';
import {
  CLIENT_EVENT_TYPES,
  ClientEventSchemas,
  type ClientEventType,
  type ErrorCode,
  forbiddenByVoice,
  type OcrContext,
  RESERVED_CLIENT_EVENTS,
  type Timeframe,
  TimeframeSchema,
} from '@smc/contracts';
import type { Sql } from '@smc/db';
import { Server, type Socket } from 'socket.io';
import { type ChatCaller, ChatService, type ChatSink } from '../ai/chat.service.js';
import { ExplainService } from '../ai/explain.service.js';
import { NarrativeService } from '../ai/narrative.service.js';
import { AnalysisService } from '../analysis/analysis.service.js';
import { ApiProblemError } from '../common/problem.js';
import { assertNoSecret } from '../common/secrets.js';
import { ENV, EVENT_BUS, SQL } from '../config/tokens.js';
import {
  applyHint,
  ContextService,
  type HintState,
  newHintState,
} from '../context/context.service.js';
import { GateService, type GateStateDto } from '../gate/gate.service.js';
import type { EventBus } from '../ingest/event-bus.js';
import { JournalService } from '../journal/journal.service.js';
import { type NotificationDto, NotificationsService } from '../journal/notifications.service.js';
import { MarketsService } from '../markets/markets.service.js';
import { verifyWsToken } from '../sessions/ws-token.js';
import { SetupsService } from '../setups/setups.service.js';
import { PositionMonitor } from '../trades/position-monitor.js';
import { VoiceService } from '../voice/voice.service.js';

/** Past this many queued packets a socket is slow: pushes are skipped and the client resyncs from `seq` (A02 section 4). */
const BACKPRESSURE_PACKETS = 100;
const MAX_SESSION_MS = 240 * 60_000;
const REPLAY_LIMIT = 500;
/** Large payloads are not stored in the resume log; a resume sends a fresh snapshot instead. */
const COMPACT_TYPES = new Set(['analysis.update']);
/** Streamed pieces are not kept for replay: the closing event carries the whole text. */
const NOT_LOGGED = new Set(['chat.chunk', 'explain.chunk', 'explain.stage']);
/** The resume log keeps that a command happened, not what was said or written. */
const REDACTED_LOG = new Set(['voice.final']);

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
  /** Chat messages the client asked to stop; their remaining pieces are not sent. */
  cancelled: Set<string>;
  hint: HintState;
  /** Which live setup a voice "next / previous setup" moves from. */
  setupCursor: number;
  /** Times of recent voice commands, for a per-session rate limit. */
  voiceTimes: number[];
  /** False until the stored sequence is loaded; nothing is pushed before then, so numbers never collide. */
  ready: boolean;
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
    private readonly narratives: NarrativeService,
    private readonly chat: ChatService,
    private readonly explain: ExplainService,
    private readonly contextSvc: ContextService,
    private readonly voiceSvc: VoiceService,
    private readonly journal: JournalService,
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
    this.narratives.hasWatchers = (id) => this.inRoom(id).length > 0;
    this.narratives.onReady = (id, n) => {
      for (const c of this.inRoom(id)) this.emit(c, 'narrative.done', n);
    };
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
    this.narratives.hasWatchers = null;
    this.narratives.onReady = null;
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
        join profiles p on p.id = s.user_id and p.blocked_at is null and p.deleted_at is null
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
      cancelled: new Set<string>(),
      hint: newHintState(),
      setupCursor: 0,
      voiceTimes: [],
      ready: false,
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
      ctx.ready = true;
      await socket.join(`session:${ctx.sessionId}`);
      if (ctx.instrumentId) await socket.join(`inst:${ctx.instrumentId}`);
    })().catch((e: unknown) => this.fail(ctx, e));
    // One event at a time per session, in arrival order.
    const enqueue = (work: () => Promise<void> | void): void => {
      queue = queue.then(work).catch((e: unknown) => this.fail(ctx, e));
    };

    for (const type of CLIENT_EVENT_TYPES) {
      socket.on(type, (raw: unknown) => {
        if (type === 'chat.cancel') {
          const id = (raw as { messageId?: unknown } | null)?.messageId;
          if (typeof id === 'string' && id.length <= 64) ctx.cancelled.add(id);
          return;
        }
        enqueue(() => this.handle(socket, ctx, type, raw));
      });
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
        await this.pushNarrative(ctx);
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
        await this.pushNarrative(ctx);
        return;
      case 'analysis.request':
        ctx.lastSnapshotId = null;
        await this.pushAnalysis(ctx.instrumentId, ctx);
        return;
      case 'setup.watch':
      case 'explain.cancel':
        return;
      case 'context.hint':
        await this.onHint(socket, ctx, p as unknown as OcrContext);
        return;
      case 'explain.request': {
        // The socket carries OCR text but no pixels; an image goes through POST /v1/explain.
        await this.explain.run(
          { ...this.caller(socket, ctx), sessionInstrumentId: ctx.instrumentId },
          {
            source: p.mode as 'SHARE' | 'UPLOAD',
            image: null,
            ocr: p.ocr as OcrContext | undefined,
            instrumentHint: p.instrumentHint as string | undefined,
            tfHint: p.tfHint as Timeframe | undefined,
            question: p.question as string | undefined,
          },
          {
            stage: (stage) => this.emit(ctx, 'explain.stage', { stage }),
            chunk: (delta) => this.emit(ctx, 'explain.chunk', { delta }),
            done: (e) => this.emit(ctx, 'explain.done', e),
          },
        );
        return;
      }
      case 'chat.send':
        await this.chat.send(
          this.caller(socket, ctx),
          {
            clientMsgId: p.clientMsgId as string,
            text: p.text as string,
            inputMode: p.inputMode as 'text' | 'voice',
            sttConfidence: p.sttConfidence as number | undefined,
            sttEngine: p.sttEngine as string | undefined,
          },
          this.sink(ctx),
        );
        return;
      case 'chat.cancel':
        ctx.cancelled.add(p.messageId as string);
        return;
      case 'voice.command':
        await this.voice(
          socket,
          ctx,
          p as { utteranceId: string; text: string; sttConfidence: number; sttEngine: string },
        );
        return;
      default:
        // Explain needs the chart image path (week 14).
        this.emit(ctx, 'error', {
          code: 'AI_TEMPORARILY_UNAVAILABLE',
          detail: 'This feature is not available yet.',
        });
    }
  }

  /** Who is asking, for the shared free-allowance counters only. Never sent to a model. */
  private caller(socket: Socket, ctx: Ctx): ChatCaller {
    const fwd = this.env.TRUST_PROXY_HEADERS
      ? socket.handshake.headers['x-forwarded-for']
      : undefined;
    const raw =
      (Array.isArray(fwd) ? fwd.join(',') : fwd)?.split(',').at(-1)?.trim() ||
      socket.handshake.address ||
      'unknown';
    const device: unknown = socket.handshake.auth?.deviceId;
    return {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      instrumentId: ctx.instrumentId,
      ip: raw.replace(/^::ffff:/i, ''),
      ...(typeof device === 'string' && device ? { deviceId: device.slice(0, 64) } : {}),
    };
  }

  private sink(ctx: Ctx): ChatSink {
    return {
      chunk: (e) => this.emit(ctx, 'chat.chunk', e),
      done: (e) => this.emit(ctx, 'chat.done', e),
      budget: (b) => this.emit(ctx, 'budget.update', b),
      cancelled: (id) => ctx.cancelled.has(id),
    };
  }

  /**
   * A spoken command. The closed grammar can only change the view, pause, or add a journal note; anything that could
   * move money or data is refused here and, for the gate, again by the database (invariant 1).
   */
  private async voice(
    socket: Socket,
    ctx: Ctx,
    p: { utteranceId: string; text: string; sttConfidence: number; sttEngine: string },
  ): Promise<void> {
    const sql = this.sql as Sql;
    const nowMs = Date.now();
    ctx.voiceTimes = ctx.voiceTimes.filter((x) => nowMs - x < 60_000);
    if (ctx.voiceTimes.length >= 30) {
      this.emit(ctx, 'error', {
        code: 'RATE_LIMITED',
        detail: 'Too many voice commands. Try again shortly.',
      });
      return;
    }
    ctx.voiceTimes.push(nowMs);
    const log = (outcome: string, route: string | null, command: string | null) =>
      sql`insert into voice_events (workspace_id, user_id, session_id, engine, confidence, outcome, route, command_id)
          values (${ctx.workspaceId}, ${ctx.userId}, ${ctx.sessionId}, ${p.sttEngine}, ${p.sttConfidence}, ${outcome}, ${route}, ${command})`;
    // The server corrects what was heard with its own glossary: whatever the browser did, this is the authority.
    const heard = p.text;
    const fix = await this.voiceSvc.correct(heard);
    const text = fix.text;
    const forbidden = forbiddenByVoice(heard) ?? forbiddenByVoice(text);
    if (forbidden) {
      await log('FORBIDDEN_BY_VOICE', 'COMMAND', null);
      this.emit(ctx, 'error', {
        code: 'VOICE_FORBIDDEN_ACTION',
        detail: 'That cannot be done by voice. Use the on-screen button.',
        action: forbidden,
      });
      return;
    }
    const cmd = p.sttConfidence >= 0.6 ? parseCommand(text) : null;
    if (!cmd) {
      await log(p.sttConfidence < 0.6 ? 'LOW_CONFIDENCE' : 'OK', 'QUESTION', null);
      await this.chat.send(
        this.caller(socket, ctx),
        {
          clientMsgId: p.utteranceId,
          text,
          inputMode: 'voice',
          sttConfidence: p.sttConfidence,
          sttEngine: p.sttEngine,
        },
        this.sink(ctx),
      );
      return;
    }
    await log('OK', 'COMMAND', cmd.command);
    const extra: Record<string, unknown> = {};
    if (cmd.command === 'SWITCH_TF') {
      const tf = TimeframeSchema.safeParse(cmd.tf);
      if (!tf.success) {
        this.emit(ctx, 'error', { code: 'VALIDATION_FAILED', detail: 'Unknown timeframe.' });
        return;
      }
      ctx.tf = tf.data;
      ctx.lastSnapshotId = null;
      await sql`update copilot_sessions set tf = ${tf.data} where id = ${ctx.sessionId}`;
      this.emit(ctx, 'context.updated', {
        instrumentId: ctx.canonical,
        tf: tf.data,
        source: 'voice',
      });
      await this.pushAnalysis(ctx.instrumentId, ctx);
    } else if (cmd.command === 'SWITCH_INSTRUMENT') {
      const r = await this.contextSvc.resolveText(cmd.text);
      if (r.canonical) {
        await this.setContext(socket, ctx, r.canonical, ctx.tf, 'voice');
        await this.pushAnalysis(ctx.instrumentId, ctx);
        await this.pushNarrative(ctx);
      } else {
        // Not clear (spot or perpetual, which venue) or unknown: ask, never guess.
        extra.needsPick = true;
        extra.candidates = r.candidates;
      }
    } else if (cmd.command === 'PAUSE_RESUME') {
      await sql`update copilot_sessions set state = ${cmd.resume ? 'ACTIVE' : 'PAUSED'} where id = ${ctx.sessionId} and state <> 'ENDED'`;
      this.emit(ctx, 'session.state', {
        state: cmd.resume ? 'ACTIVE' : 'PAUSED',
        sessionId: ctx.sessionId,
      });
    } else if (cmd.command === 'JOURNAL_NOTE') {
      assertNoSecret(cmd.note);
      await this.journal.addNote(ctx.userId, ctx.workspaceId, { notes: cmd.note, tags: ['voice'] });
    } else if (cmd.command === 'SHOW_SETUP' || cmd.command === 'WATCH_SETUP') {
      const live = ctx.instrumentId
        ? (await this.setups.activeFor(ctx.instrumentId, ctx.workspaceId)).filter(
            (x) => x.state === 'ARMED' || x.state === 'TRIGGERED',
          )
        : [];
      if (cmd.command === 'SHOW_SETUP') {
        const n = live.length;
        const next =
          cmd.ordinal === 'NEXT'
            ? (ctx.setupCursor + 1) % Math.max(1, n)
            : cmd.ordinal === 'PREVIOUS'
              ? (ctx.setupCursor - 1 + Math.max(1, n)) % Math.max(1, n)
              : cmd.ordinal - 1;
        const target = live[next];
        if (target) {
          ctx.setupCursor = next;
          extra.setupId = target.id;
        } else {
          extra.setupId = null;
        }
      } else {
        extra.setupId = live[ctx.setupCursor]?.id ?? null;
      }
    }
    // EXPLAIN_CHART and MUTE are carried out by the browser, which holds the capture and the speaker.
    this.emit(ctx, 'voice.final', {
      utteranceId: p.utteranceId,
      route: 'COMMAND',
      command: cmd.command,
      args: cmd,
      heard,
      corrected: fix.changes.length > 0,
      ...extra,
    });
  }

  /** An OCR hint: re-derived on the server, applied only after two consecutive agreeing hints. */
  private async onHint(socket: Socket, ctx: Ctx, ocr: OcrContext): Promise<void> {
    const ev = await this.contextSvc.evaluate(ocr, ctx.userId);
    for (const w of ev.warnings) this.emit(ctx, 'warning', w);
    const usable = ev.instrumentId !== null && !ev.ambiguous && ev.feedMatch !== 'MISMATCH';
    const { state, lock } = applyHint(ctx.hint, usable ? ev.instrumentId : null);
    ctx.hint = state;
    if (lock && ev.canonical) {
      await this.setContext(socket, ctx, ev.canonical, ev.tf ?? ctx.tf, 'ocr');
      await this.pushAnalysis(ctx.instrumentId, ctx);
      await this.pushNarrative(ctx);
    } else if (usable && ev.instrumentId === ctx.instrumentId && ev.tf && ev.tf !== ctx.tf) {
      ctx.tf = ev.tf;
      ctx.lastSnapshotId = null;
      await (this
        .sql as Sql)`update copilot_sessions set tf = ${ev.tf} where id = ${ctx.sessionId}`;
      this.emit(ctx, 'context.updated', { instrumentId: ctx.canonical, tf: ev.tf, source: 'ocr' });
      await this.pushAnalysis(ctx.instrumentId, ctx);
    }
  }

  private async setContext(
    socket: Socket,
    ctx: Ctx,
    canonical: string,
    tf: Timeframe | null,
    source: 'manual' | 'ocr' | 'voice' = 'manual',
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
    // The instrument the user is looking at now is the baseline later hints are compared with.
    ctx.hint = { candidate: null, count: 0, locked: inst.id };
    ctx.setupCursor = 0;
    this.emit(ctx, 'context.updated', { instrumentId: inst.canonical, tf, source });
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
    return [...this.sessions.values()].filter(
      (c) => c.instrumentId === instrumentId && c.socketId && c.ready,
    );
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
    const stored = REDACTED_LOG.has(type)
      ? {
          utteranceId: (payload as { utteranceId?: string }).utteranceId ?? null,
          command: (payload as { command?: string }).command ?? null,
        }
      : COMPACT_TYPES.has(type)
        ? { snapshotId: (payload as { snapshotId?: string }).snapshotId ?? null }
        : payload;
    if (this.sql && !NOT_LOGGED.has(type)) {
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
      if (c.userId === userId && c.socketId && c.ready) this.emit(c, type, payload);
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

  /** The current explanation for the session's instrument: model text if cached, else the template. */
  private async pushNarrative(ctx: Ctx): Promise<void> {
    if (!ctx.instrumentId) return;
    try {
      this.emit(ctx, 'narrative.done', await this.narratives.current(ctx.instrumentId));
    } catch (e) {
      if (e instanceof ApiProblemError && e.code === 'ANALYSIS_UNAVAILABLE') return;
      this.log.warn(`narrative push failed: ${String(e)}`);
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
    // Sessions ended over REST, and users blocked since connecting, must not keep streaming.
    const ids = [...this.sessions.keys()];
    if (ids.length > 0 && this.sql) {
      const gone = await this.sql<{ id: string }[]>`
        select s.id from copilot_sessions s join profiles p on p.id = s.user_id
         where s.id = any(${ids}) and (s.state = 'ENDED' or p.blocked_at is not null or p.deleted_at is not null)`;
      for (const g of gone) {
        const c = this.sessions.get(g.id);
        if (!c) continue;
        this.socketOf(c)?.disconnect(true);
        this.sessions.delete(g.id);
      }
    }
    for (const c of [...this.sessions.values()]) {
      if (now - c.startedAt > MAX_SESSION_MS)
        await this.endSession(c, 'MAX_DURATION').catch(() => undefined);
    }
  }
}
