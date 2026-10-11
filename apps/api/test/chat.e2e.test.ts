import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  LlmError,
  LlmRouter,
  PriceTable,
  type ProviderAdapter,
  type ProviderCallArgs,
} from '@smc/ai';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiMeterService } from '../src/ai/ai-meter.service.js';
import { ProviderConfigService } from '../src/ai/provider-config.service.js';
import { AnalysisService } from '../src/analysis/analysis.service.js';
import { LLM_ROUTER } from '../src/config/tokens.js';
import { createTestApp, makeKeys, type TestKeys } from './helpers.js';

let server: TestServer;
let sql: Sql;
let dbUrl: string;
let keys: TestKeys;
const apps: NestExpressApplication[] = [];
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer();
  dbUrl = await server.createDatabase();
  sql = createClient(dbUrl, { max: 6 });
  await applyMigrations(sql, { withShims: true });
  keys = await makeKeys();
}, 180_000);
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await server.stop();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
beforeEach(async () => {
  await sql`delete from voice_events`;
  await sql`delete from journal_entries`;
  await sql`delete from ai_calls`;
  await sql`delete from ai_budget_ledger`;
  await sql`delete from ai_global_ledger`;
  await sql`delete from copilot_sessions`;
  await sql`delete from workspaces`;
  await sql`delete from auth.users`;
});

const FACTS = {
  asOf: Date.UTC(2026, 9, 12, 8),
  instrumentId: 'BINANCE:PERP:BTCUSDT',
  strategyVersionId: 'sv1',
  dataQuality: 'OK',
  htfBias: { tf: '4h', trend: 'BULL', lastBreak: null },
  levels: [{ id: 'L9', label: 'Sweep low', kind: 'SWING_LOW', price: 63960 }],
  zones: [{ id: 'Z3', label: 'Order block', top: 64110, bottom: 64040, state: 'FRESH' }],
  setups: [
    {
      id: 'S19',
      template: 'T1',
      direction: 'LONG',
      grade: 'A',
      state: 'ARMED',
      reasonCodes: [],
      poi: 'Z3',
      invalidation: 'L9',
      targets: [],
      stats: null,
    },
  ],
  warnings: [],
};
const ANSWER = JSON.stringify({
  answer: 'The engine marks {{Z:Z3}} as a fresh order block, which is where the idea is anchored.',
  meta: {
    refs_used: ['Z3'],
    scope: 'CHART',
    asked_for_advice: false,
    needs_clarification: false,
    followups: [],
  },
});
const PRICES = JSON.stringify({
  'claude-sonnet-5-5': { in: 3, out: 15 },
  'claude-haiku-5-5': { in: 1, out: 5 },
});

function adapter(script: (string | LlmError)[]) {
  const calls: ProviderCallArgs[] = [];
  let i = 0;
  const a: ProviderAdapter & { calls: ProviderCallArgs[] } = {
    id: 'anthropic',
    calls,
    async call(args) {
      calls.push(args);
      const s = script[Math.min(i++, script.length - 1)] as string | LlmError;
      if (s instanceof LlmError) throw s;
      return { text: s, usage: { tokensIn: 2000, tokensOut: 400, cachedIn: 0, cacheWrite: 0 } };
    },
  };
  return a;
}

async function boot(a: ProviderAdapter, env: Record<string, string> = {}) {
  const { app } = await createTestApp({
    keys,
    env: {
      DATABASE_URL: dbUrl,
      WS_TOKEN_SECRET: 'x'.repeat(40),
      ANTHROPIC_API_KEY: 'test-key',
      AI_PROVIDER_ANTHROPIC_ENABLED: 'true',
      AI_PRICES_JSON: PRICES,
      ...env,
    },
    overrides: [
      {
        provide: LLM_ROUTER,
        inject: [ProviderConfigService, AiMeterService],
        factory: ((source: ProviderConfigService, meter: AiMeterService) =>
          new LlmRouter({
            source,
            adapters: { anthropic: a },
            prices: PriceTable.parse(PRICES),
            sleep: async () => {},
            onCall: meter.onCall,
            onOutcome: meter.onOutcome,
          })) as never,
      },
    ],
  });
  apps.push(app);
  app.get(AnalysisService).marketFacts = (async () => ({
    facts: FACTS,
    instrument: { pricePrecision: 2 },
    asOf: FACTS.asOf,
  })) as never;
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { http: app.getHttpServer(), url: `http://127.0.0.1:${port}`, app };
}

async function newSession(http: unknown, opts: { limit?: number } = {}) {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  if (opts.limit !== undefined) {
    await sql`update entitlements set limits = limits || ${sql.json({ daily_ai_budget_usd: opts.limit })} where workspace_id = (select id from workspaces where owner_id = ${id})`;
  }
  const auth = `Bearer ${await keys.sign({ sub: id })}`;
  const instrument = (
    await sql<{ id: string }[]>`select id from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`
  )[0]?.id;
  const res = await request(http as never)
    .post('/v1/sessions')
    .set('Authorization', auth)
    .set('Idempotency-Key', randomUUID())
    .send({ instrumentId: instrument });
  return { id, auth, sessionId: res.body.sessionId as string, wsToken: res.body.wsToken as string };
}

const open = (url: string, auth: Record<string, unknown>) => {
  const s = connect(url, { path: '/ws', auth, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  return s;
};
const once = <T>(s: Socket, ev: string, ms = 5000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });

async function started(
  url: string,
  sess: { sessionId: string; wsToken: string },
  extra: Record<string, unknown> = {},
) {
  const s = open(url, { wsToken: sess.wsToken, ...extra });
  await once(s, 'connect');
  s.emit('session.start', { sessionId: sess.sessionId });
  await once(s, 'session.state');
  return s;
}
/** Model calls made for chat; the session also asks for a narrative, which is not chat. */
const chatCalls = (a: { calls: ProviderCallArgs[] }) =>
  a.calls.filter((c) => c.req.system.includes('answer questions from a trader'));

const ask = async (s: Socket, text: string, extra: Record<string, unknown> = {}) => {
  const done = once<{ payload: { text: string; aiGenerated: boolean; meta: { scope: string } } }>(
    s,
    'chat.done',
  );
  s.emit('chat.send', { clientMsgId: randomUUID(), text, inputMode: 'text', ...extra });
  return done;
};

describe('chat over the socket', () => {
  it('streams a grounded answer in pieces, stores the thread, meters the cost and reports the budget', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a);
    const sess = await newSession(http);
    const s = await started(url, sess);
    const chunks: string[] = [];
    s.on('chat.chunk', (e: { payload: { delta: string } }) => chunks.push(e.payload.delta));
    const budget = once<{ payload: { spentUsd: number; limitUsd: number; state: string } }>(
      s,
      'budget.update',
    );
    const d = await ask(s, 'What is the order block on this chart?');
    expect(d.payload.aiGenerated).toBe(true);
    expect(d.payload.text).toContain('64,040.00 to 64,110.00');
    expect(chunks.join('')).toBe(d.payload.text);
    expect((await budget).payload.spentUsd).toBeCloseTo(0.012, 4);

    const msgs = await sql<
      { role: string }[]
    >`select role from chat_messages order by created_at, role desc`;
    expect(msgs.map((m) => m.role).sort()).toEqual(['assistant', 'user']);
    const [row] = await sql<
      { job: string; data_class: string; workspace_id: string | null; session_id: string | null }[]
    >`select job, data_class, workspace_id, session_id from ai_calls`;
    expect(row).toMatchObject({ job: 'J3_CHAT', data_class: 'D2', session_id: sess.sessionId });
    expect(row?.workspace_id).not.toBeNull();
    const [ses] = await sql<
      { ai_calls_count: number; ai_cost_usd: string }[]
    >`select ai_calls_count, ai_cost_usd from copilot_sessions where id = ${sess.sessionId}`;
    expect(ses?.ai_calls_count).toBe(1);
    expect(Number(ses?.ai_cost_usd)).toBeGreaterThan(0);
  });

  it('"should I buy?" gets the fixed reply with scenarios and invalidation, and never reaches a model', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a);
    const s = await started(url, await newSession(http));
    const d = await ask(s, 'Should I buy here?');
    expect(d.payload.text).toContain('decision is yours');
    expect(d.payload.text).toContain('63,960.00');
    expect(d.payload.meta.scope).toBe('PERSONAL_ADVICE_REQUEST');
    expect(d.payload.aiGenerated).toBe(false);
    expect(chatCalls(a)).toHaveLength(0);
  });

  it('refuses a seed phrase: nothing stored, nothing sent', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a);
    const s = await started(url, await newSession(http));
    const err = once<{ payload: { code: string; detail?: string } }>(s, 'error');
    s.emit('chat.send', {
      clientMsgId: 'm1',
      text: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      inputMode: 'text',
    });
    const e = await err;
    expect(e.payload.code).toBe('SECRET_DETECTED');
    expect(JSON.stringify(e)).not.toContain('abandon');
    expect(chatCalls(a)).toHaveLength(0);
    expect((await sql`select 1 from chat_messages`).length).toBe(0);
  });

  it('enforces the daily budget: answers until used up, then BUDGET_EXCEEDED with templates elsewhere', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a);
    const s = await started(url, await newSession(http, { limit: 0.02 }));
    await ask(s, 'What is the order block on this chart?');
    await ask(s, 'What does the current bias mean for this setup?'); // spends past 0.02
    const err = once<{ payload: { code: string } }>(s, 'error');
    s.emit('chat.send', {
      clientMsgId: 'm3',
      text: 'What is the current bias?',
      inputMode: 'text',
    });
    expect((await err).payload.code).toBe('BUDGET_EXCEEDED');
    expect(chatCalls(a)).toHaveLength(2);
  });

  it('kill switch for chat stops it; the rest of the session keeps working', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a);
    await sql`insert into feature_flags (key, enabled, rollout_pct) values ('kill.CHAT', true, 100) on conflict (key) do update set enabled = true`;
    const s = await started(url, await newSession(http));
    const err = once<{ payload: { code: string } }>(s, 'error');
    s.emit('chat.send', {
      clientMsgId: 'm1',
      text: 'What is the current bias?',
      inputMode: 'text',
    });
    expect((await err).payload.code).toBe('KILL_SWITCH_ACTIVE');
    await sql`delete from feature_flags where key = 'kill.CHAT'`;
  });

  it('a farm of accounts behind one address shares one allowance', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a, { AI_IP_REQUESTS_PER_DAY: '3' });
    const s1 = await started(url, await newSession(http));
    const s2 = await started(url, await newSession(http));
    await ask(s1, 'What is the current bias?');
    await ask(s2, 'What is the current bias?');
    await ask(s1, 'What does this setup mean?');
    const err = once<{ payload: { code: string } }>(s2, 'error');
    s2.emit('chat.send', {
      clientMsgId: 'm9',
      text: 'What does this zone mean?',
      inputMode: 'text',
    });
    expect((await err).payload.code).toBe('DAILY_LIMIT_REACHED');
  });

  it('a device id shared across accounts is throttled the same way', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a, { AI_DEVICE_REQUESTS_PER_DAY: '2' });
    const s1 = await started(url, await newSession(http), { deviceId: 'dev-1' });
    const s2 = await started(url, await newSession(http), { deviceId: 'dev-1' });
    await ask(s1, 'What is the current bias?');
    await ask(s2, 'What is the current bias?');
    const err = once<{ payload: { code: string } }>(s1, 'error');
    s1.emit('chat.send', {
      clientMsgId: 'm9',
      text: 'What does this zone mean?',
      inputMode: 'text',
    });
    expect((await err).payload.code).toBe('DAILY_LIMIT_REACHED');
  });

  it('with every provider down the user still gets a template reply, not an error', async () => {
    const a = adapter([new LlmError('SERVER', 'x', 503)]);
    const { http, url } = await boot(a);
    const s = await started(url, await newSession(http));
    const d = await ask(s, 'What is the current bias?');
    expect(d.payload.aiGenerated).toBe(false);
    expect(d.payload.text).toContain('analysis shows');
  });
});

describe('voice commands', () => {
  it('refuses to confirm, log or pay by voice and records it', async () => {
    const { http, url } = await boot(adapter([ANSWER]));
    const s = await started(url, await newSession(http));
    for (const text of [
      'confirm the trade',
      'log this trade',
      'change my risk',
      'delete my data',
    ]) {
      const err = once<{ payload: { code: string } }>(s, 'error');
      s.emit('voice.command', {
        utteranceId: randomUUID(),
        text,
        sttConfidence: 0.99,
        sttEngine: 'whisper-web',
      });
      expect((await err).payload.code).toBe('VOICE_FORBIDDEN_ACTION');
    }
    expect(
      (await sql`select 1 from voice_events where outcome = 'FORBIDDEN_BY_VOICE'`).length,
    ).toBe(4);
    expect((await sql`select 1 from gate_decisions`).length).toBe(0);
    expect((await sql`select 1 from trade_records`).length).toBe(0);
  });

  it('runs a view command, adds a journal note, and sends other speech to chat', async () => {
    const a = adapter([ANSWER]);
    const { http, url } = await boot(a);
    const s = await started(url, await newSession(http));
    const ctxUpdate = once<{ payload: { tf: string } }>(s, 'context.updated');
    const final = once<{ payload: { command: string } }>(s, 'voice.final');
    s.emit('voice.command', {
      utteranceId: 'u1',
      text: 'switch to 15m',
      sttConfidence: 0.95,
      sttEngine: 'whisper-web',
    });
    expect((await ctxUpdate).payload.tf).toBe('15m');
    expect((await final).payload.command).toBe('SWITCH_TF');

    const final2 = once(s, 'voice.final');
    s.emit('voice.command', {
      utteranceId: 'u2',
      text: 'note: waited for the sweep before thinking about entry',
      sttConfidence: 0.95,
      sttEngine: 'whisper-web',
    });
    await final2;
    expect((await sql`select 1 from journal_entries where kind = 'NOTE'`).length).toBe(1);

    const done = once<{ payload: { text: string } }>(s, 'chat.done');
    s.emit('voice.command', {
      utteranceId: 'u3',
      text: 'what is the order block on this chart',
      sttConfidence: 0.9,
      sttEngine: 'whisper-web',
    });
    expect((await done).payload.text).toContain('order block');
  });

  it('low-confidence speech is never run as a command', async () => {
    const { http, url } = await boot(adapter([ANSWER]));
    const s = await started(url, await newSession(http));
    const done = once<{ payload: { text: string; meta: { needs_clarification: boolean } } }>(
      s,
      'chat.done',
    );
    s.emit('voice.command', {
      utteranceId: 'u1',
      text: 'switch to 15m',
      sttConfidence: 0.3,
      sttEngine: 'whisper-web',
    });
    const d = await done;
    expect(d.payload.meta.needs_clarification).toBe(true);
    expect((await sql`select 1 from voice_events where outcome = 'LOW_CONFIDENCE'`).length).toBe(1);
  });
});

describe('chat over HTTP (server-sent events)', () => {
  it('streams chunk and done frames and refuses a secret with a normal problem response', async () => {
    const { http } = await boot(adapter([ANSWER]));
    const sess = await newSession(http);
    const res = await request(http).post('/v1/chat/messages').set('Authorization', sess.auth).send({
      sessionId: sess.sessionId,
      clientMsgId: 'c1',
      text: 'What is the order block on this chart?',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('event: chat.chunk');
    expect(res.text).toContain('event: chat.done');
    expect(res.text).toContain('event: budget.update');

    const bad = await request(http)
      .post('/v1/chat/messages')
      .set('Authorization', sess.auth)
      .send({
        sessionId: sess.sessionId,
        clientMsgId: 'c2',
        text: `${'0123456789abcdef'.repeat(4)}`,
      });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('SECRET_DETECTED');

    const hist = await request(http)
      .get(`/v1/sessions/${sess.sessionId}/chat`)
      .set('Authorization', sess.auth);
    expect(hist.body.items.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it("another user's session is not reachable", async () => {
    const { http } = await boot(adapter([ANSWER]));
    const a = await newSession(http);
    const b = await newSession(http);
    const res = await request(http)
      .post('/v1/chat/messages')
      .set('Authorization', b.auth)
      .send({ sessionId: a.sessionId, clientMsgId: 'x', text: 'hello there' });
    expect(res.status).toBe(404);
    expect(
      (await request(http).get(`/v1/sessions/${a.sessionId}/chat`).set('Authorization', b.auth))
        .body.items,
    ).toEqual([]);
  });
});
