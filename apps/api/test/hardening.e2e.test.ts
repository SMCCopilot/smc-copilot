import { randomUUID } from 'node:crypto';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminSourceIp } from '../src/admin/admin.guard.js';
import { configureApp } from '../src/bootstrap.js';
import { createTestApp, LogSink, makeKeys, type TestKeys } from './helpers.js';

// Built at run time so that scanners do not mistake test sentinels for real credentials.
const M_TOKEN = ['metrics', 'token', 'for', 'tests', 'abc123xyz'].join('-');
const FAKE_KEY = ['sk', 'ant', 'SENTINEL', 'do', 'not', 'leak', '0000000000'].join('-');
const FAKE_KEY2 = ['sk', 'ant', 'SENTINEL', 'LOGS', '0000000000000000'].join('-');

let server: TestServer;
let sql: Sql;
let dbUrl: string;
let keys: TestKeys;
const apps: NestExpressApplication[] = [];

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
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
beforeEach(async () => {
  await sql`delete from journal_entries`;
  await sql`delete from notifications`;
  await sql`delete from workspaces`;
  await sql`delete from auth.users`;
});

async function boot(env: Record<string, string> = {}, logSink?: LogSink) {
  const { app } = await createTestApp({
    keys,
    ...(logSink ? { logSink } : {}),
    env: { DATABASE_URL: dbUrl, WS_TOKEN_SECRET: 'x'.repeat(40), ...env },
  });
  apps.push(app);
  return app;
}

async function readyUser() {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  const token = await keys.sign({ sub: id });
  const [ws] = await sql<{ id: string }[]>`select id from workspaces where owner_id = ${id}`;
  return { id, token, auth: `Bearer ${token}`, workspaceId: ws?.id as string };
}

describe('GET /metrics', () => {
  it('does not exist without a token configured, and needs the exact token when it does', async () => {
    const off = await boot();
    expect((await request(off.getHttpServer()).get('/metrics')).status).toBe(404);
    const on = await boot({ METRICS_TOKEN: M_TOKEN });
    const http = on.getHttpServer();
    expect((await request(http).get('/metrics')).status).toBe(401);
    expect((await request(http).get('/metrics').set('Authorization', 'Bearer nope')).status).toBe(
      401,
    );
    const res = await request(http).get('/metrics').set('Authorization', `Bearer ${M_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('serves the metrics the alert rules use, and no personal data', async () => {
    const app = await boot({
      METRICS_TOKEN: M_TOKEN,
      ANTHROPIC_API_KEY: FAKE_KEY,
    });
    const http = app.getHttpServer();
    const u = await readyUser();
    await request(http).get('/v1/me').set('Authorization', u.auth);
    await sql`insert into ai_global_ledger (day, cost_usd, calls, cap_usd) values ((now() at time zone 'utc')::date, 2.5, 4, 10)`;
    const text = (await request(http).get('/metrics').set('Authorization', `Bearer ${M_TOKEN}`))
      .text;
    for (const name of [
      'smc_up',
      'smc_process_uptime_seconds',
      'smc_realtime_sockets',
      'smc_http_requests_total',
      'smc_ai_spend_usd_today',
      'smc_ai_cap_usd',
      'smc_ai_cap_tripped',
      'smc_sessions_open',
      'smc_candle_partitions_ahead',
      'smc_db_size_bytes',
    ]) {
      expect(text, name).toContain(name);
    }
    expect(text).toMatch(/smc_ai_spend_usd_today 2\.5/);
    expect(text).toMatch(/smc_ai_cap_usd 10/);
    expect(text).not.toContain(u.id);
    expect(text).not.toContain(u.workspaceId);
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('metrics-token');
    // Valid Prometheus lines: name{labels} value
    for (const line of text.split('\n').filter((l) => l && !l.startsWith('#'))) {
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.eE+-]+$/);
    }
  });
});

describe('log redaction', () => {
  it('no token, key, invite code, signature or wallet secret reaches the logs', async () => {
    const sink = new LogSink();
    const SECRET_KEY = FAKE_KEY2;
    const app = await boot(
      {
        ANTHROPIC_API_KEY: SECRET_KEY,
        METRICS_TOKEN: M_TOKEN,
        LOG_LEVEL: 'debug',
      },
      sink,
    );
    const http = app.getHttpServer();
    const u = await readyUser();
    const seed =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await request(http)
      .get('/v1/me')
      .set('Authorization', u.auth)
      .set('Cookie', 'session=COOKIE-SENTINEL-123');
    await request(http)
      .post('/v1/journal/notes')
      .set('Authorization', u.auth)
      .send({ notes: seed, tags: [] });
    await request(http)
      .post('/v1/chat/messages')
      .set('Authorization', u.auth)
      .send({ sessionId: randomUUID(), clientMsgId: 'x', text: `0x${'ab'.repeat(32)}` });
    await request(http).get('/v1/setups').set('Authorization', 'Bearer not.a.token');
    await request(http).get('/metrics').set('Authorization', `Bearer ${M_TOKEN}`);
    await new Promise((r) => setTimeout(r, 200));
    const logs = sink.text;
    expect(logs.length).toBeGreaterThan(100); // the requests really were logged
    for (const secret of [
      u.token,
      SECRET_KEY,
      'COOKIE-SENTINEL-123',
      M_TOKEN.slice(0, 20),
      'x'.repeat(40),
      'abandon abandon',
      'ab'.repeat(32),
      'not.a.token',
    ]) {
      expect(logs, secret).not.toContain(secret);
    }
  });
});

describe('tenant isolation matrix', () => {
  it('another user cannot read or change any resource that belongs to someone else', async () => {
    const app = await boot();
    const http = app.getHttpServer();
    const a = await readyUser();
    const b = await readyUser();
    const inst = (
      await sql<
        { id: string }[]
      >`select id from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`
    )[0]?.id as string;
    const trade = await request(http)
      .post('/v1/trades')
      .set('Authorization', a.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ instrumentId: inst, direction: 'LONG', entryPrice: 100, stopPrice: 99 });
    const session = await request(http)
      .post('/v1/sessions')
      .set('Authorization', a.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ instrumentId: inst });
    const note = await request(http)
      .post('/v1/journal/notes')
      .set('Authorization', a.auth)
      .send({ notes: 'mine', tags: [] });
    const [n] = await sql<
      { id: string }[]
    >`insert into notifications (workspace_id, user_id, channel, type, payload, status) values (${a.workspaceId}, ${a.id}, 'IN_APP', 't', '{}'::jsonb, 'SENT') returning id`;
    const sid = session.body.sessionId as string;
    const checks: [string, string, number, Record<string, unknown>?][] = [
      ['get', `/v1/trades/${trade.body.id}`, 404],
      ['post', `/v1/trades/${trade.body.id}/close`, 404, { exitPrice: 101 }],
      ['patch', `/v1/trades/${trade.body.id}`, 404, { notes: 'hijack' }],
      ['get', `/v1/sessions/${sid}`, 404],
      ['post', `/v1/sessions/${sid}/ws-token`, 404],
      ['post', `/v1/sessions/${sid}/end`, 404],
      ['get', `/v1/sessions/${sid}/chat`, 200],
      ['patch', `/v1/journal/${note.body.id}`, 404, { notes: 'hijack' }],
      ['post', `/v1/notifications/${n?.id}/read`, 404],
      ['get', `/v1/gate/${randomUUID()}`, 404],
    ];
    for (const [method, path, want, body] of checks) {
      const r = await (request(http) as never as Record<string, (p: string) => request.Test>)
        [method]?.(path)
        .set('Authorization', b.auth)
        .send(body ?? {});
      expect(r?.status, `${method} ${path}`).toBe(want);
    }
    // The listing endpoints show B nothing of A's.
    expect((await request(http).get('/v1/trades').set('Authorization', b.auth)).body.items).toEqual(
      [],
    );
    expect(
      (await request(http).get('/v1/journal').set('Authorization', b.auth)).body.items,
    ).toEqual([]);
    expect(
      (await request(http).get('/v1/notifications').set('Authorization', b.auth)).body.items,
    ).toEqual([]);
    expect(
      (await request(http).get('/v1/sessions').set('Authorization', b.auth)).body.items,
    ).toEqual([]);
    expect(
      (await request(http).get(`/v1/sessions/${sid}/chat`).set('Authorization', b.auth)).body.items,
    ).toEqual([]);
    // And A's data is intact.
    expect(
      (await request(http).get(`/v1/trades/${trade.body.id}`).set('Authorization', a.auth)).body
        .status,
    ).toBe('OPEN');
  });
});

describe('every admin route is behind the admin guard', () => {
  it('scans the controllers', async () => {
    const app = await boot();
    const R = Reflect as unknown as { getMetadata: (k: string, t: object) => unknown };
    let seen = 0;
    const missing: string[] = [];
    for (const m of app.get(ModulesContainer).values()) {
      for (const w of m.controllers.values()) {
        const cls = w.metatype as (new (...a: never[]) => object) | null;
        if (!cls) continue;
        const prefix = String(R.getMetadata('path', cls) ?? '');
        if (!prefix.startsWith('v1/admin')) continue;
        const guards = (
          (R.getMetadata('__guards__', cls) as { name?: string }[] | undefined) ?? []
        ).map((g) => g.name);
        seen++;
        if (!guards.includes('AdminGuard') || !guards.includes('JwtAuthGuard'))
          missing.push(prefix);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(4);
    expect(missing).toEqual([]);
  });
});

describe('proxy handling', () => {
  it('trusts exactly one proxy hop in production, and none elsewhere', () => {
    const calls: [string, unknown][] = [];
    const fake = {
      set: (k: string, v: unknown) => calls.push([k, v]),
      use: () => {},
      useBodyParser: () => {},
      useLogger: () => {},
      get: () => ({}),
      enableCors: () => {},
      enableShutdownHooks: () => {},
    };
    configureApp(fake as never, { NODE_ENV: 'production', CORS_ORIGINS: [] } as never);
    expect(calls).toContainEqual(['trust proxy', 1]);
    calls.length = 0;
    configureApp(fake as never, { NODE_ENV: 'development', CORS_ORIGINS: [] } as never);
    expect(calls.some(([k]) => k === 'trust proxy')).toBe(false);
  });

  it('the admin source address is the one Express resolved, unless the tunnel header is trusted', () => {
    expect(adminSourceIp({ headers: {}, ip: '::ffff:203.0.113.9' }, false)).toBe('203.0.113.9');
    expect(
      adminSourceIp({ headers: { 'cf-connecting-ip': '198.51.100.7' }, ip: '10.0.0.1' }, false),
    ).toBe('10.0.0.1');
    expect(
      adminSourceIp({ headers: { 'cf-connecting-ip': '198.51.100.7' }, ip: '10.0.0.1' }, true),
    ).toBe('198.51.100.7');
  });
});

describe('retention', () => {
  it('removes data past its retention period and keeps the rest', async () => {
    const app = await boot();
    const u = await readyUser();
    const inst = (
      await sql<
        { id: string }[]
      >`select id from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`
    )[0]?.id as string;
    const [s] = await sql<
      { id: string }[]
    >`insert into copilot_sessions (workspace_id, user_id, instrument_id) values (${u.workspaceId}, ${u.id}, ${inst}) returning id`;
    const sid = s?.id as string;
    await sql`insert into session_events (session_id, seq, type, payload, created_at) values (${sid}, 1, 't', '{}'::jsonb, now() - interval '8 days'), (${sid}, 2, 't', '{}'::jsonb, now() - interval '1 day')`;
    await sql`insert into voice_events (workspace_id, user_id, engine, outcome, at) values (${u.workspaceId}, ${u.id}, 'typed', 'OK', now() - interval '31 days'), (${u.workspaceId}, ${u.id}, 'typed', 'OK', now() - interval '2 days')`;
    const [t] = await sql<
      { id: string }[]
    >`insert into chat_threads (workspace_id, user_id, session_id, created_at) values (${u.workspaceId}, ${u.id}, ${sid}, now() - interval '100 days') returning id`;
    await sql`insert into chat_messages (thread_id, role, content, created_at) values (${t?.id as string}, 'user', 'old', now() - interval '91 days'), (${t?.id as string}, 'user', 'new', now() - interval '1 day')`;
    await sql`insert into audit_log (action, at) values ('old.thing', now() - interval '400 days'), ('new.thing', now())`;
    const { RetentionService } = await import('../src/ops/retention.service.js');
    const r = await app.get(RetentionService).run();
    expect(r).toMatchObject({ session_events: 1, voice_events: 1, chat_messages: 1, audit_log: 1 });
    expect((await sql`select 1 from session_events where session_id = ${sid}`).length).toBe(1);
    expect((await sql`select 1 from voice_events where user_id = ${u.id}`).length).toBe(1);
    expect(
      (await sql`select 1 from chat_messages where thread_id = ${t?.id as string}`).length,
    ).toBe(1);
    expect((await sql`select 1 from audit_log where action = 'new.thing'`).length).toBe(1);
  });
});
