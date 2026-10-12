import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  await sql`delete from audit_log`;
  await sql`delete from ai_calls`;
  await sql`delete from workspaces`;
  await sql`delete from auth.users`;
});

async function boot(env: Record<string, string> = {}) {
  const { app } = await createTestApp({
    keys,
    env: {
      DATABASE_URL: dbUrl,
      WS_TOKEN_SECRET: 'x'.repeat(40),
      ACCOUNT_PURGE_INTERVAL_MIN: '0',
      ...env,
    },
  });
  apps.push(app);
  return app.getHttpServer();
}

async function fullUser(http: unknown) {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`insert into auth.identities (user_id, provider, identity_data, last_sign_in_at)
            values (${id}, 'web3', ${sql.json({ custom_claims: { address: `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`, chain: 'ethereum' } })}, now())`;
  await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  const auth = `Bearer ${await keys.sign({ sub: id })}`;
  const [ws] = await sql<{ id: string }[]>`select id from workspaces where owner_id = ${id}`;
  const workspaceId = ws?.id as string;
  const inst = (
    await sql<{ id: string }[]>`select id from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`
  )[0]?.id as string;
  await request(http as never)
    .get('/v1/me')
    .set('Authorization', auth); // mirrors the wallet
  const s = await request(http as never)
    .post('/v1/sessions')
    .set('Authorization', auth)
    .set('Idempotency-Key', randomUUID())
    .send({ instrumentId: inst });
  await request(http as never)
    .post('/v1/trades')
    .set('Authorization', auth)
    .set('Idempotency-Key', randomUUID())
    .send({
      instrumentId: inst,
      direction: 'LONG',
      entryPrice: 100,
      stopPrice: 99,
      notes: 'first trade',
    });
  await request(http as never)
    .post('/v1/journal/notes')
    .set('Authorization', auth)
    .send({ notes: 'a private thought', tags: ['mine'] });
  await request(http as never)
    .post('/v1/risk/size')
    .set('Authorization', auth)
    .send({});
  await request(http as never)
    .put('/v1/risk-profile')
    .set('Authorization', auth)
    .send({ balance: 5000 });
  await request(http as never)
    .post('/v1/chat/messages')
    .set('Authorization', auth)
    .send({
      sessionId: s.body.sessionId,
      clientMsgId: 'c1',
      text: 'What is the bias on this chart now?',
    });
  await request(http as never)
    .post('/v1/voice/events')
    .set('Authorization', auth)
    .send({ sessionId: s.body.sessionId, engine: 'typed', outcome: 'OK' });
  await request(http as never)
    .post('/v1/feedback')
    .set('Authorization', auth)
    .send({ targetType: 'setup', targetId: 'x', rating: 1, comment: 'nice' });
  await sql`insert into notifications (workspace_id, user_id, channel, type, payload, status) values (${workspaceId}, ${id}, 'IN_APP', 't', '{}'::jsonb, 'SENT')`;
  await sql`insert into ai_calls (workspace_id, user_id, session_id, job, data_class, provider, model, prompt_version, outcome)
            values (${workspaceId}, ${id}, ${s.body.sessionId}, 'J3_CHAT', 'D2', 'anthropic', 'm', 'v', 'OK')`;
  await sql`insert into audit_log (actor_id, workspace_id, action, target, detail) values (${id}, ${workspaceId}, 'x.test', ${id}, ${sql.json({ who: id })})`;
  return { id, auth, workspaceId, sessionId: s.body.sessionId as string };
}

/** Every place a user or workspace id could be found, across every table. */
async function residue(ids: string[]): Promise<string[]> {
  const cols = await sql<{ table_name: string; column_name: string }[]>`
    select c.table_name, c.column_name from information_schema.columns c
      join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
       and c.data_type in ('uuid','text','character varying','jsonb','json','ARRAY')`;
  const hits: string[] = [];
  for (const { table_name, column_name } of cols) {
    for (const id of ids) {
      const r = await sql.unsafe(
        `select 1 from "${table_name}" where cast("${column_name}" as text) like $1 limit 1`,
        [`%${id}%`],
      );
      if (r.length > 0) hits.push(`${table_name}.${column_name}`);
    }
  }
  return hits;
}

describe('DELETE /v1/me', () => {
  it('needs a fresh signature and the exact phrase', async () => {
    const http = await boot();
    const u = await fullUser(http);
    const old = `Bearer ${await keys.sign({ sub: u.id, issuedAt: Math.floor(Date.now() / 1000) - 3600 })}`;
    expect(
      (
        await request(http)
          .delete('/v1/me')
          .set('Authorization', old)
          .send({ confirm: 'DELETE MY ACCOUNT' })
      ).status,
    ).toBe(401);
    expect(
      (await request(http).delete('/v1/me').set('Authorization', u.auth).send({ confirm: 'yes' }))
        .status,
    ).toBe(422);
    expect(
      (await request(http).delete('/v1/me').set('Authorization', u.auth).send({})).status,
    ).toBe(422);
  });

  it('blocks the account at once, closes the session, and can be cancelled inside the grace period', async () => {
    const http = await boot();
    const u = await fullUser(http);
    const res = await request(http)
      .delete('/v1/me')
      .set('Authorization', u.auth)
      .send({ confirm: 'DELETE MY ACCOUNT' });
    expect(res.status).toBe(200);
    expect(new Date(res.body.purgeAfter).getTime()).toBeGreaterThan(Date.now());
    expect((await request(http).get('/v1/me').set('Authorization', u.auth)).status).toBe(401);
    expect((await request(http).get('/v1/trades').set('Authorization', u.auth)).status).toBe(401);
    const [s] = await sql<
      { state: string }[]
    >`select state from copilot_sessions where id = ${u.sessionId}`;
    expect(s?.state).toBe('ENDED');

    expect(
      (await request(http).post('/v1/me/deletion/cancel').set('Authorization', u.auth)).status,
    ).toBe(204);
    expect((await request(http).get('/v1/me').set('Authorization', u.auth)).status).toBe(200);
    expect(
      (await request(http).post('/v1/me/deletion/cancel').set('Authorization', u.auth)).status,
    ).toBe(404);
  });

  it('does not purge inside the grace period', async () => {
    const http = await boot();
    const u = await fullUser(http);
    await request(http)
      .delete('/v1/me')
      .set('Authorization', u.auth)
      .send({ confirm: 'DELETE MY ACCOUNT' });
    const admin = `Bearer ${await keys.sign({ sub: randomUUID(), claims: { app_metadata: { role: 'admin' } } })}`;
    const run = await request(http)
      .post('/v1/admin/deletions/run')
      .set('Authorization', admin)
      .set('X-Admin-Confirm', 'yes');
    expect(run.body.purged).toBe(0);
    expect((await sql`select 1 from profiles where id = ${u.id}`).length).toBe(1);
  });
});

describe('purge', () => {
  it('removes the user and everything that identifies them, and nobody else', async () => {
    const http = await boot({ ACCOUNT_DELETION_GRACE_HOURS: '0' });
    const gone = await fullUser(http);
    const keep = await fullUser(http);
    // Sanity: the seeded data really is spread over many tables.
    expect(await residue([gone.id])).not.toEqual([]);

    await request(http)
      .delete('/v1/me')
      .set('Authorization', gone.auth)
      .send({ confirm: 'DELETE MY ACCOUNT' });
    await sql`update audit_log set ip = '203.0.113.7' where actor_id = ${gone.id}`;
    const admin = `Bearer ${await keys.sign({ sub: randomUUID(), claims: { app_metadata: { role: 'admin' } } })}`;
    const run = await request(http)
      .post('/v1/admin/deletions/run')
      .set('Authorization', admin)
      .set('X-Admin-Confirm', 'yes');
    expect(run.body.purged).toBe(1);
    expect((await sql`select 1 from audit_log where ip = '203.0.113.7'`).length).toBe(0);

    expect(await residue([gone.id, gone.workspaceId])).toEqual([]);
    expect((await sql`select 1 from auth.users where id = ${gone.id}`).length).toBe(0);
    // The other user is untouched.
    expect((await sql`select 1 from trade_records where user_id = ${keep.id}`).length).toBe(1);
    expect(
      (await sql`select 1 from journal_entries where user_id = ${keep.id}`).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await sql`select 1 from chat_messages m join chat_threads t on t.id = m.thread_id where t.user_id = ${keep.id}`
      ).length,
    ).toBeGreaterThan(0);
    // The audit trail records that a purge happened, without saying whose.
    expect((await sql`select 1 from audit_log where action = 'account.purged'`).length).toBe(1);
    expect(
      (await sql`select 1 from audit_log where action = 'x.test' and actor_id is null`).length,
    ).toBe(1);
  });

  it('is safe to run again', async () => {
    const http = await boot({ ACCOUNT_DELETION_GRACE_HOURS: '0' });
    const u = await fullUser(http);
    await request(http)
      .delete('/v1/me')
      .set('Authorization', u.auth)
      .send({ confirm: 'DELETE MY ACCOUNT' });
    const admin = `Bearer ${await keys.sign({ sub: randomUUID(), claims: { app_metadata: { role: 'admin' } } })}`;
    await request(http)
      .post('/v1/admin/deletions/run')
      .set('Authorization', admin)
      .set('X-Admin-Confirm', 'yes');
    const again = await request(http)
      .post('/v1/admin/deletions/run')
      .set('Authorization', admin)
      .set('X-Admin-Confirm', 'yes');
    expect(again.body.purged).toBe(0);
  });
});
