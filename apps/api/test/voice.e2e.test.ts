import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { VoiceConfigSchema } from '@smc/contracts';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function user(http: unknown) {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
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

const once = <T>(s: Socket, ev: string, ms = 5000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
    s.once(ev, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });

async function started(url: string, u: { sessionId: string; wsToken: string }) {
  const s = connect(url, {
    path: '/ws',
    auth: { wsToken: u.wsToken },
    transports: ['websocket'],
    reconnection: false,
  });
  sockets.push(s);
  await once(s, 'connect');
  s.emit('session.start', { sessionId: u.sessionId });
  await once(s, 'session.state');
  return s;
}
const say = (s: Socket, text: string, conf = 0.95) =>
  s.emit('voice.command', {
    utteranceId: randomUUID(),
    text,
    sttConfidence: conf,
    sttEngine: 'whisper-web',
  });

describe('GET /v1/voice/config', () => {
  it('lists pinned engines with verifiable files, says audio never leaves the device, and needs sign-in', async () => {
    const { http } = await boot();
    expect((await request(http).get('/v1/voice/config')).status).toBe(401);
    const u = await user(http);
    const res = await request(http).get('/v1/voice/config').set('Authorization', u.auth);
    expect(res.status).toBe(200);
    const cfg = VoiceConfigSchema.parse(res.body);
    expect(cfg.audioLeavesDevice).toBe(false);
    expect(cfg.engines.map((e) => e.tag)).toEqual(['whisper-web', 'moonshine-web']);
    for (const e of cfg.engines) {
      expect(e.status).toBe('READY');
      expect(e.files.length).toBeGreaterThan(3);
      for (const f of e.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
      }
    }
    expect(cfg.vad.status).toBe('READY');
    expect(cfg.glossaryVersion).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('GET /v1/voice/glossary', () => {
  it('serves terms and symbols (including the assets in the database), with a stable version', async () => {
    const { http } = await boot();
    const u = await user(http);
    const a = await request(http).get('/v1/voice/glossary').set('Authorization', u.auth);
    const b = await request(http).get('/v1/voice/glossary').set('Authorization', u.auth);
    expect(a.status).toBe(200);
    expect(a.body.version).toBe(b.body.version);
    expect(a.body.terms.map((t: { canonical: string }) => t.canonical)).toEqual(
      expect.arrayContaining(['CHoCH', 'BOS', 'FVG']),
    );
    expect(a.body.symbols.map((t: { canonical: string }) => t.canonical)).toEqual(
      expect.arrayContaining(['BTC', 'ETH']),
    );
  });
});

describe('POST /v1/voice/events', () => {
  it('stores metadata only, for the caller own session', async () => {
    const { http } = await boot();
    const a = await user(http);
    const b = await user(http);
    const ok = await request(http).post('/v1/voice/events').set('Authorization', a.auth).send({
      sessionId: a.sessionId,
      engine: 'moonshine-web',
      outcome: 'OK',
      durationMs: 2100,
      latencyMs: 900,
      confidence: 0.91,
    });
    expect(ok.status).toBe(204);
    const [row] = await sql<
      { engine: string; latency_ms: number }[]
    >`select engine, latency_ms from voice_events`;
    expect(row).toMatchObject({ engine: 'moonshine-web', latency_ms: 900 });
    expect(
      (
        await request(http)
          .post('/v1/voice/events')
          .set('Authorization', b.auth)
          .send({ sessionId: a.sessionId, engine: 'whisper-web', outcome: 'OK' })
      ).status,
    ).toBe(404);
    // No place for text or audio: unknown fields are refused.
    expect(
      (
        await request(http)
          .post('/v1/voice/events')
          .set('Authorization', a.auth)
          .send({ engine: 'whisper-web', outcome: 'OK', transcript: 'hello' })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(http)
          .post('/v1/voice/events')
          .set('Authorization', a.auth)
          .send({ engine: 'whisper-web', outcome: 'OK', audio: 'AAAA' })
      ).status,
    ).toBe(422);
  });
});

describe('voice over the socket', () => {
  it('audio events are not served and nothing is stored', async () => {
    const { http, url } = await boot();
    const s = await started(url, await user(http));
    for (const ev of ['voice.begin', 'voice.audio', 'voice.end']) {
      const err = once<{ payload: { code: string } }>(s, 'error');
      s.emit(ev, { chunk: new Uint8Array(1600) });
      expect((await err).payload.code).toBe('STT_UNAVAILABLE');
    }
    expect((await sql`select 1 from voice_events`).length).toBe(0);
  });

  it('corrects what was heard before the grammar sees it ("bee tee see" and a switch by timeframe words)', async () => {
    const { http, url } = await boot();
    const s = await started(url, await user(http));
    const f1 = once<{ payload: { command: string; args: { tf?: string }; heard: string } }>(
      s,
      'voice.final',
    );
    say(s, 'switch to fifteen minute');
    const e1 = await f1;
    expect(e1.payload).toMatchObject({
      command: 'SWITCH_TF',
      args: { tf: '15m' },
      heard: 'switch to fifteen minute',
    });
  });

  it('switches market by name, and asks when it cannot tell which', async () => {
    const { http, url } = await boot();
    const s = await started(url, await user(http));
    const updated = once<{ payload: { instrumentId: string; source: string } }>(
      s,
      'context.updated',
    );
    const f1 = once<{ payload: { needsPick?: boolean } }>(s, 'voice.final');
    say(s, 'switch to ethereum perp');
    expect((await updated).payload).toMatchObject({
      instrumentId: 'BINANCE:PERP:ETHUSDT',
      source: 'voice',
    });
    expect((await f1).payload.needsPick).toBeUndefined();

    const f2 = once<{ payload: { needsPick?: boolean; candidates?: string[] } }>(s, 'voice.final');
    say(s, 'switch to dogecoinxyz');
    const e2 = await f2;
    expect(e2.payload.needsPick).toBe(true);
    expect(e2.payload.candidates).toEqual([]);
  });

  it('mute, explain and next setup are handed back to the browser to carry out', async () => {
    const { http, url } = await boot();
    const s = await started(url, await user(http));
    for (const [text, command] of [
      ['mute', 'MUTE'],
      ['explain this chart', 'EXPLAIN_CHART'],
      ['next setup', 'SHOW_SETUP'],
      ['watch this setup', 'WATCH_SETUP'],
    ] as const) {
      const f = once<{ payload: { command: string } }>(s, 'voice.final');
      say(s, text);
      expect((await f).payload.command).toBe(command);
    }
    expect((await sql`select 1 from voice_events where route = 'COMMAND'`).length).toBe(4);
  });

  it('every forbidden request is refused with the specific action and changes nothing', async () => {
    const { http, url } = await boot();
    const s = await started(url, await user(http));
    const asked = [
      'confirm the trade',
      'confirm the gate',
      'log this trade',
      'change my risk',
      'delete my account',
      'delete my journal',
      'upgrade my plan',
    ];
    for (const text of asked) {
      const err = once<{ payload: { code: string; action: string } }>(s, 'error');
      say(s, text, 0.99);
      const e = await err;
      expect(e.payload.code).toBe('VOICE_FORBIDDEN_ACTION');
      expect(e.payload.action).toBeTruthy();
    }
    expect(
      (await sql`select 1 from voice_events where outcome = 'FORBIDDEN_BY_VOICE'`).length,
    ).toBe(asked.length);
    expect((await sql`select 1 from gate_decisions`).length).toBe(0);
    expect((await sql`select 1 from trade_records`).length).toBe(0);
    expect((await sql`select 1 from workspaces`).length).toBe(1);
  });

  it('a spoken request that only sounds forbidden after correction is still refused', async () => {
    const { http, url } = await boot();
    const s = await started(url, await user(http));
    const err = once<{ payload: { code: string } }>(s, 'error');
    say(s, 'Confirm the, trade!');
    expect((await err).payload.code).toBe('VOICE_FORBIDDEN_ACTION');
  });
});
