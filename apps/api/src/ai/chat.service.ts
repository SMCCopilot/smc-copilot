import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  answerChat,
  CHAT_PROMPT_VERSION,
  type ChatResult,
  type LlmRouter,
  type LlmTurn,
  summarizeChat,
} from '@smc/ai';
import type { Env } from '@smc/config';
import type { BudgetState } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { ApiProblemError } from '../common/problem.js';
import { assertNoSecret } from '../common/secrets.js';
import { ENV, LLM_ROUTER, SQL } from '../config/tokens.js';
import { JournalService } from '../journal/journal.service.js';
import { withAiContext } from './ai.context.js';
import { AiAllowanceService } from './ai-allowance.service.js';
import { AiGateService } from './ai-gate.service.js';
import { NarrativeService } from './narrative.service.js';

const WINDOW_TURNS = 8;
const WINDOW_CHARS = 10_000;
const SUMMARY_AFTER = 16;
const CHUNK_CHARS = 90;

export interface ChatCaller {
  sessionId: string;
  userId: string;
  workspaceId: string;
  instrumentId: string | null;
  /** Network address and browser id, used only for the shared free-allowance counters. Never sent to a model. */
  ip: string;
  deviceId?: string | undefined;
}
export interface ChatSink {
  chunk(e: { messageId: string; clientMsgId: string; delta: string }): void;
  done(e: {
    messageId: string;
    clientMsgId: string;
    text: string;
    aiGenerated: boolean;
    meta: ChatResult['meta'];
  }): void;
  budget(b: BudgetState): void;
  cancelled(clientMsgId: string): boolean;
}

export interface ChatBody {
  clientMsgId: string;
  text: string;
  inputMode: 'text' | 'voice';
  sttConfidence?: number | undefined;
  sttEngine?: string | undefined;
}

/**
 * Chat end to end (A05 section 7): refuse secrets, enforce rate and spend limits, run the deterministic screens and the
 * model, store the thread, and hand the validated answer to the caller in chunks. The answer is checked before any
 * of it is sent, so nothing needs retracting.
 */
@Injectable()
export class ChatService {
  private readonly log = new Logger('Chat');

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
    @Inject(LLM_ROUTER) private readonly router: LlmRouter,
    private readonly gate: AiGateService,
    private readonly allowance: AiAllowanceService,
    private readonly narratives: NarrativeService,
    private readonly journal: JournalService,
  ) {}

  private get db(): Sql {
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sql;
  }

  private async thread(c: ChatCaller): Promise<{ id: string; summary: string | null }> {
    const [t] = await this.db<{ id: string; summary: string | null }[]>`
      select id, summary from chat_threads where session_id = ${c.sessionId} and user_id = ${c.userId}
       order by created_at limit 1`;
    if (t) return t;
    const [n] = await this.db<{ id: string }[]>`
      insert into chat_threads (workspace_id, user_id, session_id) values (${c.workspaceId}, ${c.userId}, ${c.sessionId})
      returning id`;
    return { id: (n as { id: string }).id, summary: null };
  }

  private async window(threadId: string): Promise<{ turns: LlmTurn[]; total: number }> {
    const rows = await this.db<{ role: string; content: string }[]>`
      select role, content from chat_messages
       where thread_id = ${threadId} and not retracted and role in ('user','assistant')
       order by created_at desc limit ${WINDOW_TURNS}`;
    const [c] = await this.db<
      { n: number }[]
    >`select count(*)::int as n from chat_messages where thread_id = ${threadId}`;
    let size = 0;
    const turns: LlmTurn[] = [];
    for (const r of rows) {
      size += r.content.length;
      if (size > WINDOW_CHARS) break;
      turns.unshift({ role: r.role as 'user' | 'assistant', content: r.content });
    }
    return { turns, total: c?.n ?? 0 };
  }

  async send(c: ChatCaller, b: ChatBody, sink: ChatSink): Promise<void> {
    // 1. Secrets first: nothing is stored, logged or sent anywhere.
    assertNoSecret(b.text);
    // 2. Rate limits, then kill switches / global cap / the user's daily budget.
    this.allowance.check(
      c,
      'chat',
      this.env.AI_USER_MESSAGES_PER_MINUTE,
      this.env.AI_USER_MESSAGES_PER_DAY,
    );
    const verdict = await this.gate.check(['AI', 'CHAT'], c.workspaceId);
    if (!verdict.allowed) {
      if (verdict.reason === 'USER_BUDGET') {
        if (verdict.budget) sink.budget(verdict.budget);
        throw new ApiProblemError(
          'BUDGET_EXCEEDED',
          'Your daily AI allowance is used up. It resets at midnight UTC.',
        );
      }
      if (verdict.reason === 'KILL_SWITCH')
        throw new ApiProblemError('KILL_SWITCH_ACTIVE', 'Chat is temporarily switched off.');
      throw new ApiProblemError('AI_TEMPORARILY_UNAVAILABLE', 'AI features are paused for today.');
    }

    const thread = await this.thread(c);
    const { turns, total } = await this.window(thread.id);
    await this.db`
      insert into chat_messages (thread_id, role, content, input_mode, stt_engine, stt_confidence)
      values (${thread.id}, 'user', ${b.text}, ${b.inputMode === 'voice' ? 'VOICE' : 'TEXT'}, ${b.sttEngine ?? (b.inputMode === 'voice' ? null : 'typed')}, ${b.sttConfidence ?? null})`;

    let facts = null;
    let precision = 2;
    if (c.instrumentId) {
      try {
        const f = await this.narratives.factsFor(c.instrumentId);
        facts = f.facts;
        precision = f.instrument.pricePrecision;
      } catch (e) {
        if (!(e instanceof ApiProblemError) || e.code !== 'ANALYSIS_UNAVAILABLE') throw e;
      }
    }
    const result = await withAiContext(
      {
        workspaceId: c.workspaceId,
        userId: c.userId,
        sessionId: c.sessionId,
        promptVersion: CHAT_PROMPT_VERSION,
      },
      () =>
        answerChat(this.router, {
          text: b.text,
          inputMode: b.inputMode,
          sttConfidence: b.sttConfidence,
          history: turns,
          summary: thread.summary,
          facts,
          precision,
          soft: verdict.soft,
        }),
    );
    let text = result.text;
    if (result.meta.scope === 'JOURNAL' && result.kind === 'TEMPLATE' && text === '') {
      text = await this.journalReply(c.workspaceId);
    }

    const [msg] = await this.db<{ id: string }[]>`
      insert into chat_messages (thread_id, role, content, meta)
      values (${thread.id}, 'assistant', ${text}, ${this.db.json({ ...result.meta, kind: result.kind } as never)})
      returning id`;
    const messageId = (msg as { id: string }).id;
    for (const piece of pieces(text)) {
      if (sink.cancelled(b.clientMsgId)) break;
      sink.chunk({ messageId, clientMsgId: b.clientMsgId, delta: piece });
    }
    sink.done({
      messageId,
      clientMsgId: b.clientMsgId,
      text,
      aiGenerated: result.kind === 'MODEL',
      meta: result.meta,
    });

    const cost = result.calls.reduce((s, x) => s + x.costUsd, 0);
    if (result.calls.length > 0) {
      await this.db`
        update copilot_sessions set ai_calls_count = ai_calls_count + ${result.calls.length}, ai_cost_usd = ai_cost_usd + ${cost}
         where id = ${c.sessionId}`;
    }
    sink.budget(await this.gate.budget(c.workspaceId));
    if (total + 2 > SUMMARY_AFTER && (total + 2) % 8 < 2) void this.refreshSummary(c, thread.id);
  }

  private async journalReply(workspaceId: string): Promise<string> {
    const s = await this.journal.summary(workspaceId);
    const win =
      s.winRate === null
        ? 'A win rate appears after 30 closed trades with a measured result.'
        : `Your win rate is ${Math.round(s.winRate * 100)} percent.`;
    return `Your journal has ${s.closedTrades} closed and ${s.openTrades} open trades and ${s.setupsShown} setups shown to you. ${win}`;
  }

  /** Condense everything older than the window into a short summary. Best effort; failure only means no summary. */
  private async refreshSummary(c: ChatCaller, threadId: string): Promise<void> {
    try {
      const rows = await this.db<{ role: string; content: string }[]>`
        select role, content from chat_messages
         where thread_id = ${threadId} and not retracted and role in ('user','assistant')
         order by created_at desc offset ${WINDOW_TURNS} limit 20`;
      const older: LlmTurn[] = rows
        .reverse()
        .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
      const summary = await withAiContext(
        {
          workspaceId: c.workspaceId,
          userId: c.userId,
          sessionId: c.sessionId,
          promptVersion: `${CHAT_PROMPT_VERSION}+summary`,
        },
        () => summarizeChat(this.router, older),
      );
      if (summary)
        await this.db`update chat_threads set summary = ${summary} where id = ${threadId}`;
    } catch (e) {
      this.log.warn(`summary failed: ${String(e)}`);
    }
  }

  async history(sessionId: string, userId: string, limit = 50) {
    const rows = await this.db<
      { id: string; role: string; content: string; meta: unknown; created_at: Date }[]
    >`
      select m.id, m.role, m.content, m.meta, m.created_at
        from chat_messages m join chat_threads t on t.id = m.thread_id
       where t.session_id = ${sessionId} and t.user_id = ${userId} and not m.retracted
       order by m.created_at desc limit ${limit}`;
    return {
      items: rows.reverse().map((r) => ({
        id: r.id,
        role: r.role,
        text: r.content,
        meta: r.meta,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }
}

/** Splits an answer into short pieces on word boundaries, for incremental display. */
export function pieces(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/(\s+)/)) {
    if (cur.length + word.length > CHUNK_CHARS && cur) {
      out.push(cur);
      cur = '';
    }
    cur += word;
  }
  if (cur) out.push(cur);
  return out;
}
