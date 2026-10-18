import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { RiskProfileDtoSchema, SessionCreatedSchema } from '@smc/contracts';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signWsToken, verifyWsToken } from '../src/sessions/ws-token.js';
import { createTestApp, makeKeys, type TestKeys } from './helpers.js';

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
  await sql`delete from idempotency_keys`;
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
  return app.getHttpServer();
}

async function readyUser() {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  return `Bearer ${await keys.sign({ sub: id })}`;
}
const instrumentId = async () =>
  (
    await sql<{ id: string }[]>`select id from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`
  )[0]?.id ?? '';

describe('ws token', () => {
  it('round-trips, and rejects tampering, expiry and other secrets', () => {
    const { token, exp } = signWsToken('s'.repeat(40), { sid: 'a', uid: 'b' }, 1000);
    expect(verifyWsToken('s'.repeat(40), token, 1001)).toEqual({ sid: 'a', uid: 'b', exp });
    expect(verifyWsToken('t'.repeat(40), token, 1001)).toBeNull();
    expect(verifyWsToken('s'.repeat(40), token, exp)).toBeNull();
    expect(verifyWsToken('s'.repeat(40), `${token}x`, 1001)).toBeNull();
    expect(verifyWsToken('s'.repeat(40), 'garbage', 1001)).toBeNull();
  });
});

describe('gates apply to the read APIs', () => {
  it('refuses a user who has not passed the gates and anyone without a token', async () => {
    const http = await boot();
    expect((await request(http).get('/v1/setups')).status).toBe(401);
    const id = randomUUID();
    await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
    const res = await request(http)
      .get('/v1/setups')
      .set('Authorization', `Bearer ${await keys.sign({ sub: id })}`);
    expect(res.status).toBe(403);
  });
});

describe('setups and cohorts', () => {
  it('returns empty lists on an empty database and never a small-n cohort rate', async () => {
    const http = await boot();
    const auth = await readyUser();
    const list = await request(http).get('/v1/setups').set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
    expect((await request(http).get('/v1/setups/rejected').set('Authorization', auth)).status).toBe(
      200,
    );
    expect(
      (await request(http).get(`/v1/setups/${randomUUID()}`).set('Authorization', auth)).status,
    ).toBe(404);
    const cohorts = await request(http).get('/v1/stats/cohorts').set('Authorization', auth);
    expect(cohorts.status).toBe(200);
    expect(JSON.stringify(cohorts.body)).not.toMatch(/"winRate"\s*:\s*[0-9]/);
    expect(
      (await request(http).get('/v1/stats/cohorts?all=true').set('Authorization', auth)).status,
    ).toBe(403);
  });
});

describe('analysis', () => {
  it('says so when the engine has no state for the instrument', async () => {
    const http = await boot();
    const res = await request(http)
      .get(`/v1/instruments/${await instrumentId()}/analysis`)
      .set('Authorization', await readyUser());
    expect([404, 503]).toContain(res.status);
    expect(res.body.code ?? res.body.type).toBeTruthy();
  });
});

describe('risk', () => {
  it('stores a profile with defaults and rejects an invalid one', async () => {
    const http = await boot();
    const auth = await readyUser();
    const got = await request(http).get('/v1/risk-profile').set('Authorization', auth);
    expect(got.status).toBe(200);
    RiskProfileDtoSchema.parse(got.body);
    const put = await request(http)
      .put('/v1/risk-profile')
      .set('Authorization', auth)
      .send({ balance: 10_000, riskPerTradePct: 1 });
    expect(put.status).toBe(200);
    expect(
      (await request(http).get('/v1/risk-profile').set('Authorization', auth)).body.balance,
    ).toBe(10_000);
    const bad = await request(http)
      .put('/v1/risk-profile')
      .set('Authorization', auth)
      .send({ riskPerTradePct: -1 });
    expect(bad.status).toBe(422);
  });
});

describe('sessions', () => {
  it('creates a session with a verifiable ws token, replays on the same idempotency key, 409 on a different body', async () => {
    const http = await boot();
    const auth = await readyUser();
    const body = { instrumentId: await instrumentId(), mode: 'FEED' };
    const key = randomUUID();
    const a = await request(http)
      .post('/v1/sessions')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .send(body);
    expect(a.status).toBe(201);
    const created = SessionCreatedSchema.parse(a.body);
    expect(
      verifyWsToken('x'.repeat(40), created.wsToken, Math.floor(Date.now() / 1000)),
    ).toMatchObject({
      sid: created.sessionId,
    });

    const b = await request(http)
      .post('/v1/sessions')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .send(body);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.sessionId).toBe(created.sessionId);

    const c = await request(http)
      .post('/v1/sessions')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .send({ ...body, mode: 'APPROX' });
    expect(c.status).toBe(409);
  });

  it('enforces the concurrent limit, then allows a new one after ending', async () => {
    const http = await boot();
    const auth = await readyUser();
    const first = await request(http)
      .post('/v1/sessions')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(first.status).toBe(201);
    const second = await request(http)
      .post('/v1/sessions')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(second.status).toBe(409);
    expect(
      (
        await request(http)
          .post(`/v1/sessions/${first.body.sessionId}/end`)
          .set('Authorization', auth)
      ).status,
    ).toBe(204);
    expect(
      (
        await request(http)
          .post('/v1/sessions')
          .set('Authorization', auth)
          .set('Idempotency-Key', randomUUID())
          .send({})
      ).status,
    ).toBe(201);
  });

  it('parallel creates cannot exceed the concurrent limit', async () => {
    const http = await boot();
    const auth = await readyUser();
    const go = () =>
      request(http)
        .post('/v1/sessions')
        .set('Authorization', auth)
        .set('Idempotency-Key', randomUUID())
        .send({});
    const res = await Promise.all([go(), go(), go(), go()]);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("does not show one user's session to another", async () => {
    const http = await boot();
    const a = await readyUser();
    const b = await readyUser();
    const s = await request(http)
      .post('/v1/sessions')
      .set('Authorization', a)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(
      (await request(http).get(`/v1/sessions/${s.body.sessionId}`).set('Authorization', b)).status,
    ).toBe(404);
    expect(
      (
        await request(http)
          .post(`/v1/sessions/${s.body.sessionId}/ws-token`)
          .set('Authorization', b)
      ).status,
    ).toBe(404);
  });
});
