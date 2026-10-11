import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { evaluatePosition, type WatchedTrade } from '../src/trades/position-monitor.js';
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
  await sql`delete from idempotency_keys`;
  await sql`delete from journal_entries`;
  await sql`delete from copilot_sessions`;
  await sql`delete from workspaces`;
  await sql`delete from auth.users`;
});

async function boot() {
  const { app } = await createTestApp({
    keys,
    env: { DATABASE_URL: dbUrl, WS_TOKEN_SECRET: 'x'.repeat(40) },
  });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { http: app.getHttpServer(), url: `http://127.0.0.1:${port}` };
}

async function userSession(http: unknown) {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  const auth = `Bearer ${await keys.sign({ sub: id })}`;
  const res = await request(http as never)
    .post('/v1/sessions')
    .set('Authorization', auth)
    .set('Idempotency-Key', randomUUID())
    .send({});
  return { auth, sessionId: res.body.sessionId as string, wsToken: res.body.wsToken as string };
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

describe('socket', () => {
  it('refuses a missing or forged token', async () => {
    const { url } = await boot();
    const s = open(url, { wsToken: 'v1.forged.token' });
    const err = await once<Error>(s, 'connect_error');
    expect(err.message).toBe('AUTH_REQUIRED');
  });

  it('starts a session, numbers events, and resumes after a reconnect', async () => {
    const { http, url } = await boot();
    const { sessionId, wsToken } = await userSession(http);
    const a = open(url, { wsToken });
    await once(a, 'connect');
    a.emit('session.start', { sessionId });
    const first = await once<{ seq: number; payload: { state: string } }>(a, 'session.state');
    expect(first.payload.state).toBe('ACTIVE');
    expect(first.seq).toBeGreaterThan(0);
    a.disconnect();

    const b = open(url, { wsToken });
    await once(b, 'connect');
    b.emit('session.start', { sessionId, lastSeq: 0 });
    const replayed = await once<{ seq: number; replayed?: boolean }>(b, 'session.state');
    expect(replayed.replayed).toBe(true);
    expect(replayed.seq).toBe(first.seq);
    const stored = await sql<
      { n: number }[]
    >`select count(*)::int as n from session_events where session_id = ${sessionId}`;
    expect(stored[0]?.n).toBeGreaterThan(0);
  });

  it('allows one controller; a second tab is refused unless it takes over', async () => {
    const { http, url } = await boot();
    const { sessionId, wsToken } = await userSession(http);
    const a = open(url, { wsToken });
    await once(a, 'connect');
    a.emit('session.start', { sessionId });
    await once(a, 'session.state');

    const b = open(url, { wsToken });
    const refused = await once<{ code: string }>(b, 'error');
    expect(refused.code).toBe('SESSION_CONTROLLER_TAKEN');

    const lost = once<{ code: string }>(a, 'error');
    const c = open(url, { wsToken, takeover: true });
    await once(c, 'connect');
    expect((await lost).code).toBe('SESSION_CONTROLLER_TAKEN');
  });

  it('rejects malformed events, answers without AI configured, and has no event that confirms a gate or logs a trade', async () => {
    const { http, url } = await boot();
    const { sessionId, wsToken } = await userSession(http);
    const a = open(url, { wsToken });
    await once(a, 'connect');
    a.emit('session.start', { sessionId });
    await once(a, 'session.state');

    a.emit('chat.send', { nope: true });
    expect((await once<{ payload: { code: string } }>(a, 'error')).payload.code).toBe(
      'VALIDATION_FAILED',
    );
    // No provider is enabled here: chat still answers, with the deterministic template, and does not error.
    a.emit('chat.send', { clientMsgId: 'm1', text: 'hello', inputMode: 'text' });
    const done = await once<{ payload: { aiGenerated: boolean } }>(a, 'chat.done');
    expect(done.payload.aiGenerated).toBe(false);
    // Unknown events are ignored, never acted on: nothing here can create a gate decision or a trade.
    a.emit('gate.confirm', { token: 'x' });
    a.emit('trade.open', { instrumentId: randomUUID() });
    await new Promise((r) => setTimeout(r, 300));
    expect((await sql`select 1 from gate_decisions`).length).toBe(0);
    expect((await sql`select 1 from trade_records`).length).toBe(0);
  });

  it('ends the session on session.end', async () => {
    const { http, url } = await boot();
    const { sessionId, wsToken } = await userSession(http);
    const a = open(url, { wsToken });
    await once(a, 'connect');
    a.emit('session.start', { sessionId });
    await once(a, 'session.state');
    a.emit('session.end', {});
    await once(a, 'disconnect');
    const [row] = await sql<
      { state: string }[]
    >`select state from copilot_sessions where id = ${sessionId}`;
    expect(row?.state).toBe('ENDED');
    const again = open(url, { wsToken });
    expect((await once<Error>(again, 'connect_error')).message).toBe('SESSION_NOT_ACTIVE');
  });
});

describe('position evaluation', () => {
  const long: WatchedTrade = {
    direction: 'LONG',
    entry: 100,
    stop: 95,
    targets: [110],
    leverage: null,
    setupState: null,
    feedStale: false,
  };
  it('detects stop and target touches from the bar range, mirrored for shorts', () => {
    expect(evaluatePosition(long, { h: 101, l: 94, c: 96 })).toContain('sl_hit');
    expect(evaluatePosition(long, { h: 111, l: 99, c: 108 })).toContain('tp_hit');
    const short: WatchedTrade = { ...long, direction: 'SHORT', stop: 105, targets: [90] };
    expect(evaluatePosition(short, { h: 106, l: 99, c: 104 })).toContain('sl_hit');
    expect(evaluatePosition(short, { h: 101, l: 89, c: 92 })).toContain('tp_hit');
  });
  it('reports near levels, and quiet when far from everything', () => {
    expect(evaluatePosition(long, { h: 97, l: 95.5, c: 95.8 })).toEqual(['near_stop']);
    expect(evaluatePosition(long, { h: 109.5, l: 108, c: 109 })).toEqual(['near_target']);
    expect(evaluatePosition(long, { h: 102, l: 100, c: 101 })).toEqual([]);
  });
  it('reports setup closure, stale data and liquidation proximity', () => {
    expect(
      evaluatePosition({ ...long, setupState: 'INVALIDATED' }, { h: 102, l: 100, c: 101 }),
    ).toContain('invalidated');
    expect(
      evaluatePosition({ ...long, setupState: 'EXPIRED' }, { h: 102, l: 100, c: 101 }),
    ).toContain('thesis_degraded');
    expect(evaluatePosition({ ...long, feedStale: true }, { h: 102, l: 100, c: 101 })).toContain(
      'stale_data',
    );
    expect(
      evaluatePosition({ ...long, stop: null, leverage: 20 }, { h: 100, l: 95.3, c: 95.4 }),
    ).toContain('liquidation_risk');
  });
});
