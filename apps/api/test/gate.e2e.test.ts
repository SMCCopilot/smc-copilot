import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { realizedR } from '../src/trades/trades.service.js';
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
  await sql`delete from journal_entries`;
  await sql`delete from trade_records`;
  await sql`delete from gate_decisions`;
  await sql`delete from trade_plans`;
  await sql`delete from setups`;
  await sql`delete from idempotency_keys`;
  await sql`delete from workspaces`;
  await sql`delete from auth.users`;
});

async function boot() {
  const { app } = await createTestApp({ keys, env: { DATABASE_URL: dbUrl } });
  apps.push(app);
  return app.getHttpServer();
}

async function readyUser() {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  return { id, auth: `Bearer ${await keys.sign({ sub: id })}` };
}

/** A throwaway ARMED setup with one plan, in the test database only. */
async function armedPlan(state = 'ARMED') {
  const [inst] = await sql<
    { id: string }[]
  >`select id from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`;
  const [sv] = await sql<
    { id: string }[]
  >`select id from strategy_versions order by version desc limit 1`;
  const [s] = await sql<{ id: string }[]>`
    insert into setups (setup_key, strategy_version_id, instrument_id, template, direction, entry_tf, bias_tf, state, components, poi, invalidation, created_at)
    values (${randomUUID()}, ${sv?.id as string}, ${inst?.id as string}, 'T1', 'LONG', '15m', '4h', ${state}, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now())
    returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into trade_plans (setup_id, plan, plan_hash) values (${s?.id as string}, '{}'::jsonb, 'hash-v1-aaaaaaaa') returning id`;
  return { setupId: s?.id ?? '', planId: p?.id ?? '', instrumentId: inst?.id ?? '' };
}

async function issue(http: unknown, auth: string, planId: string) {
  return request(http as never)
    .post('/v1/gate/issue')
    .set('Authorization', auth)
    .send({ planId });
}

describe('execution gate', () => {
  it('issues a token once, stores only its hash, confirms with UI_TAP, and refuses a second confirm', async () => {
    const http = await boot();
    const u = await readyUser();
    const { planId } = await armedPlan();
    const i = await issue(http, u.auth, planId);
    expect(i.status).toBe(201);
    const [row] = await sql<{ token_hash: string; confirmed_via: string | null }[]>`
      select token_hash, confirmed_via from gate_decisions where id = ${i.body.gateId}`;
    expect(row?.token_hash).not.toBe(i.body.token);
    expect(row?.confirmed_via).toBeNull();

    const body = { token: i.body.token, planHash: i.body.planHash };
    const c1 = await request(http)
      .post(`/v1/gate/${i.body.gateId}/confirm`)
      .set('Authorization', u.auth)
      .send(body);
    expect(c1.status).toBe(201);
    expect(c1.body.state).toBe('CONFIRMED');
    const [after] = await sql<
      { confirmed_via: string }[]
    >`select confirmed_via from gate_decisions where id = ${i.body.gateId}`;
    expect(after?.confirmed_via).toBe('UI_TAP');
    const c2 = await request(http)
      .post(`/v1/gate/${i.body.gateId}/confirm`)
      .set('Authorization', u.auth)
      .send(body);
    expect(c2.status).toBe(403);
  });

  it('refuses a voice-marked confirmation and a wrong token, and the database refuses a non-tap channel', async () => {
    const http = await boot();
    const u = await readyUser();
    const { planId } = await armedPlan();
    const i = await issue(http, u.auth, planId);
    const good = { token: i.body.token, planHash: i.body.planHash };
    expect(
      (
        await request(http)
          .post(`/v1/gate/${i.body.gateId}/confirm`)
          .set('Authorization', u.auth)
          .set('X-Input-Mode', 'voice')
          .send(good)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(http)
          .post(`/v1/gate/${i.body.gateId}/confirm`)
          .set('Authorization', u.auth)
          .send({ ...good, token: 'x'.repeat(43) })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(http)
          .post(`/v1/gate/${i.body.gateId}/confirm`)
          .set('Authorization', u.auth)
          .send({ ...good, planHash: 'other-hash-1234' })
      ).status,
    ).toBe(403);
    await expect(
      sql`update gate_decisions set action = 'CONFIRMED', decided_at = now(), confirmed_via = 'VOICE' where id = ${i.body.gateId}`,
    ).rejects.toThrow();
    await expect(
      sql`update gate_decisions set action = 'CONFIRMED', decided_at = now() where id = ${i.body.gateId}`,
    ).rejects.toThrow();
  });

  it('expires after 60 seconds', async () => {
    const http = await boot();
    const u = await readyUser();
    const { planId } = await armedPlan();
    const i = await issue(http, u.auth, planId);
    await sql`update gate_decisions set issued_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where id = ${i.body.gateId}`;
    const c = await request(http)
      .post(`/v1/gate/${i.body.gateId}/confirm`)
      .set('Authorization', u.auth)
      .send({ token: i.body.token, planHash: i.body.planHash });
    expect(c.status).toBe(410);
  });

  it('is bound to the plan: a revised plan voids the gate and blocks new issues for the old plan', async () => {
    const http = await boot();
    const u = await readyUser();
    const { planId, setupId } = await armedPlan();
    const i = await issue(http, u.auth, planId);
    await sql`insert into trade_plans (setup_id, plan_version, plan, plan_hash) values (${setupId}, 2, '{}'::jsonb, 'hash-v2-bbbbbbbb')`;
    const c = await request(http)
      .post(`/v1/gate/${i.body.gateId}/confirm`)
      .set('Authorization', u.auth)
      .send({ token: i.body.token, planHash: i.body.planHash });
    expect(c.status).toBe(409);
    expect((await issue(http, u.auth, planId)).status).toBe(409);
  });

  it('refuses a setup that is no longer actionable, and another user cannot use the gate', async () => {
    const http = await boot();
    const a = await readyUser();
    const b = await readyUser();
    expect((await issue(http, a.auth, (await armedPlan('EXPIRED')).planId)).status).toBe(409);
    const { planId } = await armedPlan();
    const i = await issue(http, a.auth, planId);
    const c = await request(http)
      .post(`/v1/gate/${i.body.gateId}/confirm`)
      .set('Authorization', b.auth)
      .send({ token: i.body.token, planHash: i.body.planHash });
    expect(c.status).toBe(403);
  });
});

describe('trades', () => {
  async function confirmed(http: unknown, auth: string, planId: string) {
    const i = await issue(http, auth, planId);
    await request(http as never)
      .post(`/v1/gate/${i.body.gateId}/confirm`)
      .set('Authorization', auth)
      .send({ token: i.body.token, planHash: i.body.planHash });
    return i.body.gateId as string;
  }
  const tradeBody = (instrumentId: string, extra: object = {}) => ({
    instrumentId,
    direction: 'LONG',
    entryPrice: 100,
    size: 2,
    stopPrice: 99,
    targets: [102],
    ...extra,
  });
  const post = (http: unknown, auth: string, body: object) =>
    request(http as never)
      .post('/v1/trades')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  it('a plan trade needs a confirmed gate, spends it exactly once, and journals it', async () => {
    const http = await boot();
    const u = await readyUser();
    const { planId, instrumentId } = await armedPlan();
    expect((await post(http, u.auth, tradeBody(instrumentId, { planId }))).status).toBe(403);
    const gateId = await confirmed(http, u.auth, planId);
    const ok = await post(http, u.auth, tradeBody(instrumentId, { planId, gateId }));
    expect(ok.status).toBe(201);
    expect(ok.body.gateId).toBe(gateId);
    expect((await post(http, u.auth, tradeBody(instrumentId, { planId, gateId }))).status).toBe(
      403,
    );
    const kinds = await sql<
      { kind: string }[]
    >`select kind from journal_entries order by created_at`;
    expect(kinds.map((k) => k.kind).sort()).toEqual(['GATE', 'TRADE']);
  });

  it('an unconfirmed or foreign gate is refused', async () => {
    const http = await boot();
    const a = await readyUser();
    const b = await readyUser();
    const { planId, instrumentId } = await armedPlan();
    const i = await issue(http, a.auth, planId);
    expect(
      (await post(http, a.auth, tradeBody(instrumentId, { planId, gateId: i.body.gateId }))).status,
    ).toBe(403);
    const g = await confirmed(http, a.auth, planId);
    expect((await post(http, b.auth, tradeBody(instrumentId, { planId, gateId: g }))).status).toBe(
      403,
    );
  });

  it('a free-form trade needs no gate; closing computes R net of fees; other users cannot see it', async () => {
    const http = await boot();
    const a = await readyUser();
    const b = await readyUser();
    const { instrumentId } = await armedPlan();
    const t = await post(http, a.auth, tradeBody(instrumentId));
    expect(t.status).toBe(201);
    expect(
      (await request(http).get(`/v1/trades/${t.body.id}`).set('Authorization', b.auth)).status,
    ).toBe(404);
    const closed = await request(http)
      .post(`/v1/trades/${t.body.id}/close`)
      .set('Authorization', a.auth)
      .send({ exitPrice: 102, reason: 'TP' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.realizedR).toBeGreaterThan(1.85);
    expect(closed.body.realizedR).toBeLessThan(2);
    expect(
      (
        await request(http)
          .post(`/v1/trades/${t.body.id}/close`)
          .set('Authorization', a.auth)
          .send({ exitPrice: 102 })
      ).status,
    ).toBe(409);
  });
});

describe('realizedR', () => {
  it('is net of fees, signed by direction, and null without a stop', () => {
    expect(realizedR('LONG', 100, 102, 99, 0, null, undefined)).toBe(2);
    expect(realizedR('SHORT', 100, 98, 101, 0, null, undefined)).toBe(2);
    expect(realizedR('LONG', 100, 99, 99, 0, null, undefined)).toBe(-1);
    expect(realizedR('LONG', 100, 102, 99, 5, null, undefined)).toBeLessThan(2);
    expect(realizedR('LONG', 100, 102, null, 5, null, undefined)).toBeNull();
  });
});
