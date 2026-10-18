import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MeResponseSchema } from '@smc/contracts';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toChecksum, walletFromIdentity } from '../src/account/wallet.js';
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
  await sql`truncate abuse_flags, audit_log, address_blocklist`;
  await sql`delete from workspaces`; // owns profiles with no cascade
  await sql`delete from auth.users`;
  await sql`update feature_flags set enabled = false, rollout_pct = 0 where key = 'signup.open' or key like 'kill.%'`;
});

async function boot(env: Record<string, string> = {}) {
  const { app } = await createTestApp({ keys, env: { DATABASE_URL: dbUrl, ...env } });
  apps.push(app);
  return app.getHttpServer();
}

const hex = (n: number) => randomBytes(n).toString('hex');
const evm = () => `0x${hex(20)}`;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const solana = () => Array.from(randomBytes(44), (b) => B58[b % B58.length]).join('');

async function newUser(
  opts: { email?: string; wallets?: { chain: 'ethereum' | 'solana'; address: string }[] } = {},
) {
  const id = randomUUID();
  await sql`insert into auth.users (id, email, raw_user_meta_data) values (${id}, ${opts.email ?? null}, '{}'::jsonb)`;
  for (const w of opts.wallets ?? []) {
    await sql`
      insert into auth.identities (user_id, provider, identity_data, last_sign_in_at)
      values (${id}, 'web3', ${sql.json({ custom_claims: { address: w.address, chain: w.chain } })}, now())`;
  }
  return id;
}
const bearer = async (id: string, o: { issuedAt?: number } = {}) =>
  `Bearer ${await keys.sign({ sub: id, ...(o.issuedAt === undefined ? {} : { issuedAt: o.issuedAt }) })}`;
const adminBearer = async () =>
  `Bearer ${await keys.sign({ sub: await newUser(), claims: { app_metadata: { role: 'admin' } } })}`;

/** A user who has been through every gate. */
async function readyUser(wallets = [{ chain: 'ethereum' as const, address: evm() }]) {
  const id = await newUser({ wallets });
  await sql`update profiles set disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  return id;
}

describe('wallet parsing', () => {
  it('produces the EIP-55 checksum (reference vectors from the standard)', () => {
    for (const a of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]) {
      expect(toChecksum(a.toLowerCase())).toBe(a);
    }
  });

  it.each([
    [
      'custom_claims shape',
      {
        custom_claims: { address: '0xAbC0000000000000000000000000000000000001', chain: 'ethereum' },
      },
    ],
    ['flat shape', { address: '0xAbC0000000000000000000000000000000000001', chain: 'ethereum' }],
    ['subject only', { sub: 'web3:ethereum:0xAbC0000000000000000000000000000000000001' }],
  ])('reads an EVM wallet from the %s', (_n, data) => {
    expect(walletFromIdentity('web3', data)).toMatchObject({
      chain: 'evm',
      norm: '0xabc0000000000000000000000000000000000001',
    });
  });

  it('reads a Solana wallet and refuses other providers and malformed addresses', () => {
    const a = solana();
    expect(
      walletFromIdentity('web3', { custom_claims: { address: a, chain: 'solana' } }),
    ).toMatchObject({ chain: 'solana', norm: a });
    expect(walletFromIdentity('google', { address: evm(), chain: 'ethereum' })).toBeNull();
    expect(walletFromIdentity('web3', { address: '0x123', chain: 'ethereum' })).toBeNull();
    expect(walletFromIdentity('web3', {})).toBeNull();
  });
});

describe('GET /v1/me', () => {
  it('needs a token', async () => {
    expect((await request(await boot()).get('/v1/me')).status).toBe(401);
  });

  it('bootstraps a wallet-only user: mirrors the wallet, no email, gates required', async () => {
    const address = evm();
    const id = await newUser({ wallets: [{ chain: 'ethereum', address }] });
    const res = await request(await boot())
      .get('/v1/me')
      .set('Authorization', await bearer(id));
    expect(res.status).toBe(200);
    const me = MeResponseSchema.parse(res.body);
    expect(me.email).toBeNull();
    expect(me.wallets).toHaveLength(1);
    expect(me.wallets[0]).toMatchObject({
      chain: 'evm',
      primary: true,
      address: toChecksum(address),
    });
    expect(me.workspace.plan).toBe('free');
    expect(me.disclaimer).toMatchObject({
      required: true,
      currentVersion: '2026-10-01',
      acceptedVersion: null,
    });
    expect(me.ageConfirmed).toBe(false);
    expect(me.entitlements.limits.daily_ai_budget_usd).toBe(0.05);
  });

  it('is idempotent: calling twice mirrors the wallet once', async () => {
    const id = await newUser({ wallets: [{ chain: 'solana', address: solana() }] });
    const http = await boot();
    await request(http)
      .get('/v1/me')
      .set('Authorization', await bearer(id));
    await request(http)
      .get('/v1/me')
      .set('Authorization', await bearer(id));
    const [n] = await sql<
      { n: number }[]
    >`select count(*)::int n from wallet_identities where user_id = ${id}`;
    expect(n?.n).toBe(1);
  });

  it('shows a verified email when one is linked', async () => {
    const id = await newUser({ email: 'a@example.com' });
    await sql`update auth.users set email_confirmed_at = now() where id = ${id}`;
    const res = await request(await boot())
      .get('/v1/me')
      .set('Authorization', await bearer(id));
    expect(res.body.email).toEqual({ address: 'a@example.com', verified: true });
  });

  it('refuses a sanctioned address with no detail, then refuses the account everywhere', async () => {
    const address = evm();
    const id = await newUser({ wallets: [{ chain: 'ethereum', address }] });
    await sql`insert into address_blocklist (chain, address_norm, source) values ('evm', ${address}, 'OFAC_SDN')`;
    const http = await boot();
    const first = await request(http)
      .get('/v1/me')
      .set('Authorization', await bearer(id));
    expect(first.status).toBe(403);
    expect(first.body.code).toBe('ADDRESS_BLOCKED');
    expect(JSON.stringify(first.body)).not.toMatch(/OFAC|sdn/i);
    const again = await request(http)
      .get('/v1/me/wallets')
      .set('Authorization', await bearer(id));
    expect(again.body.code).toBe('ADDRESS_BLOCKED');
    const [p] = await sql<
      { blocked_at: Date | null }[]
    >`select blocked_at from profiles where id = ${id}`;
    expect(p?.blocked_at).not.toBeNull();
  });

  it('refuses a wallet that already belongs to another account', async () => {
    const address = evm();
    const a = await newUser({ wallets: [{ chain: 'ethereum', address }] });
    const b = await newUser({ wallets: [{ chain: 'ethereum', address }] });
    const http = await boot();
    expect(
      (
        await request(http)
          .get('/v1/me')
          .set('Authorization', await bearer(a))
      ).status,
    ).toBe(200);
    const res = await request(http)
      .get('/v1/me')
      .set('Authorization', await bearer(b));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WALLET_ALREADY_LINKED');
  });
});

describe('the gates (disclaimer, age; sign-up is open, no invite)', () => {
  it('walks DISCLAIMER_REQUIRED, then AGE_CONFIRMATION_REQUIRED, then opens', async () => {
    const id = await newUser({ wallets: [{ chain: 'ethereum', address: evm() }] });
    const http = await boot();
    const auth = await bearer(id);
    const wallets = () => request(http).get('/v1/me/wallets').set('Authorization', auth);

    expect((await wallets()).body.code).toBe('DISCLAIMER_REQUIRED');
    const wrong = await request(http)
      .post('/v1/me/disclaimer')
      .set('Authorization', auth)
      .send({ version: '1999-01-01' });
    expect(wrong.status).toBe(409);
    expect(
      (
        await request(http)
          .post('/v1/me/disclaimer')
          .set('Authorization', auth)
          .send({ version: '2026-10-01' })
      ).status,
    ).toBe(204);

    expect((await wallets()).body.code).toBe('AGE_CONFIRMATION_REQUIRED');
    expect(
      (
        await request(http)
          .post('/v1/me/age-confirmation')
          .set('Authorization', auth)
          .send({ confirmed: true })
      ).status,
    ).toBe(204);
    expect((await wallets()).status).toBe(200);

    const me = await request(http).get('/v1/me').set('Authorization', auth);
    expect(me.body).not.toHaveProperty('invite');
  });
});

describe('wallet management', () => {
  const stale = () => Math.floor(Date.now() / 1000) - 3600;

  it('linking needs a fresh sign-in and refuses an address in the body', async () => {
    const id = await readyUser();
    const http = await boot();
    const old = await request(http)
      .post('/v1/me/wallets')
      .set('Authorization', await bearer(id, { issuedAt: stale() }))
      .send({});
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('STEP_UP_REQUIRED');
    const claim = await request(http)
      .post('/v1/me/wallets')
      .set('Authorization', await bearer(id))
      .send({ address: evm() });
    expect(claim.status).toBe(422);
    const ok = await request(http)
      .post('/v1/me/wallets')
      .set('Authorization', await bearer(id))
      .send({});
    expect(ok.status).toBe(201);
    expect(ok.body.items).toHaveLength(1);
  });

  it('mirrors a second wallet the user linked at Supabase and keeps exactly one primary', async () => {
    const id = await readyUser();
    const http = await boot();
    await request(http)
      .get('/v1/me')
      .set('Authorization', await bearer(id));
    await sql`insert into auth.identities (user_id, provider, identity_data, last_sign_in_at) values (${id}, 'web3', ${sql.json({ custom_claims: { address: solana(), chain: 'solana' } })}, now())`;
    const res = await request(http)
      .post('/v1/me/wallets')
      .set('Authorization', await bearer(id))
      .send({});
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.filter((w: { primary: boolean }) => w.primary)).toHaveLength(1);
  });

  it('refuses to unlink the last login method, allows it when another remains, and reassigns the primary', async () => {
    const id = await readyUser([
      { chain: 'ethereum', address: evm() },
      { chain: 'ethereum', address: evm() },
    ]);
    const http = await boot();
    const list = await request(http)
      .get('/v1/me')
      .set('Authorization', await bearer(id));
    const [first, second] = list.body.wallets as { id: string; primary: boolean }[];
    expect(first?.primary).toBe(true);

    const auth = await bearer(id);
    const del = (w: string) =>
      request(http).delete(`/v1/me/wallets/${w}`).set('Authorization', auth);

    expect((await del(first?.id as string)).status).toBe(204); // primary removed, the other remains
    const after = await request(http).get('/v1/me/wallets').set('Authorization', auth);
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0]).toMatchObject({ id: second?.id, primary: true });
    const last = await del(second?.id as string);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_LOGIN_METHOD');
    // the removed wallet can no longer sign in: its identity is gone
    const [n] = await sql<
      { n: number }[]
    >`select count(*)::int n from auth.identities where user_id = ${id}`;
    expect(n?.n).toBe(1);
  });

  it('an email identity counts as another way to sign in', async () => {
    const id = await readyUser();
    await sql`insert into auth.identities (user_id, provider, identity_data) values (${id}, 'email', '{}'::jsonb)`;
    const http = await boot();
    const auth = await bearer(id);
    const list = await request(http).get('/v1/me').set('Authorization', auth);
    const del = await request(http)
      .delete(`/v1/me/wallets/${list.body.wallets[0].id}`)
      .set('Authorization', auth);
    expect(del.status).toBe(204);
  });

  it('only the owner can change or remove a wallet', async () => {
    const owner = await readyUser();
    const other = await readyUser();
    const http = await boot();
    const mine = await request(http)
      .get('/v1/me')
      .set('Authorization', await bearer(owner));
    const id = mine.body.wallets[0].id;
    expect(
      (
        await request(http)
          .post(`/v1/me/wallets/${id}/primary`)
          .set('Authorization', await bearer(other))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(http)
          .delete(`/v1/me/wallets/${id}`)
          .set('Authorization', await bearer(other))
      ).status,
    ).toBe(404);
  });
});

describe('profile', () => {
  it('updates name, locale and time zone and rejects an unknown time zone', async () => {
    const id = await newUser();
    const http = await boot();
    const auth = await bearer(id);
    expect(
      (
        await request(http)
          .patch('/v1/me')
          .set('Authorization', auth)
          .send({ displayName: 'Ada', locale: 'en-GB', timezone: 'Europe/London' })
      ).status,
    ).toBe(204);
    const me = await request(http).get('/v1/me').set('Authorization', auth);
    expect(me.body.user).toMatchObject({
      displayName: 'Ada',
      locale: 'en-GB',
      timezone: 'Europe/London',
    });
    expect(
      (
        await request(http)
          .patch('/v1/me')
          .set('Authorization', auth)
          .send({ timezone: 'Mars/Olympus' })
      ).status,
    ).toBe(422);
    expect((await request(http).patch('/v1/me').set('Authorization', auth).send({})).status).toBe(
      422,
    );
    expect(
      (await request(http).patch('/v1/me').set('Authorization', auth).send({ role: 'admin' }))
        .status,
    ).toBe(422);
  });
});

describe('admin operations', () => {
  const call = async (http: unknown, method: 'get' | 'post', path: string, body?: object) => {
    const agent = request(http as never);
    const r = method === 'get' ? agent.get(path) : agent.post(path);
    r.set('Authorization', await adminBearer()).set('X-Admin-Confirm', 'yes');
    return body ? r.send(body) : r;
  };

  it('refuses ordinary users and a missing confirmation header', async () => {
    const http = await boot();
    const u = await newUser();
    expect(
      (
        await request(http)
          .post('/v1/admin/blocklist')
          .set('Authorization', await bearer(u))
          .set('X-Admin-Confirm', 'yes')
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(http)
          .post('/v1/admin/blocklist')
          .set('Authorization', await adminBearer())
          .send({})
      ).status,
    ).toBe(403);
  });

  it('manages the blocklist: add, import (skipping bad addresses), remove', async () => {
    const http = await boot();
    const a = evm();
    expect(
      (
        await call(http, 'post', '/v1/admin/blocklist', {
          chain: 'evm',
          address: a.toUpperCase().replace('0X', '0x'),
        })
      ).status,
    ).toBe(204);
    const [one] = await sql<{ address_norm: string }[]>`select address_norm from address_blocklist`;
    expect(one?.address_norm).toBe(a);
    const imp = await call(http, 'post', '/v1/admin/blocklist/import', {
      source: 'OFAC_SDN',
      entries: [
        { chain: 'evm', address: evm() },
        { chain: 'evm', address: 'not-an-address' },
        { chain: 'solana', address: solana() },
      ],
    });
    expect(imp.body).toEqual({ imported: 2, skipped: 1 });
    expect(
      (
        await call(http, 'post', '/v1/admin/blocklist', {
          chain: 'evm',
          address: a,
          action: 'REMOVE',
        })
      ).status,
    ).toBe(204);
    expect((await sql`select 1 from address_blocklist where address_norm = ${a}`).length).toBe(0);
  });

  it('looks a user up, merges entitlements, and blocking takes effect immediately', async () => {
    const http = await boot();
    const id = await readyUser();
    const look = await call(http, 'get', `/v1/admin/users/${id}`);
    expect(look.body.profile.id).toBe(id);
    expect(look.body.entitlements.limits.chat_per_day).toBe(40);
    expect(
      (
        await call(http, 'post', `/v1/admin/users/${id}/entitlements`, {
          limits: { chat_per_day: 99 },
          features: { explain: false },
        })
      ).status,
    ).toBe(204);
    const [e] = await sql<{ limits: Record<string, number>; features: Record<string, boolean> }[]>`
      select e.limits, e.features from entitlements e join workspaces w on w.id = e.workspace_id where w.owner_id = ${id}`;
    expect(e?.limits).toMatchObject({ chat_per_day: 99, session_hours_per_month: 30 });
    expect(e?.features).toMatchObject({ explain: false, voice: true });

    expect(
      (
        await call(http, 'post', `/v1/admin/users/${id}/block`, {
          blocked: true,
          reason: 'abuse',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(http)
          .get('/v1/me/wallets')
          .set('Authorization', await bearer(id))
      ).body.code,
    ).toBe('ADDRESS_BLOCKED');
    await call(http, 'post', `/v1/admin/users/${id}/block`, { blocked: false });
    expect(
      (
        await request(http)
          .get('/v1/me/wallets')
          .set('Authorization', await bearer(id))
      ).status,
    ).toBe(200);
    expect((await call(http, 'get', `/v1/admin/users/${randomUUID()}`)).status).toBe(404);
  });

  it('flags and kill switches take effect within seconds and are audited', async () => {
    const http = await boot();
    const id = await newUser();
    expect(
      (await call(http, 'post', '/v1/admin/flags/payments.enabled', { enabled: true })).status,
    ).toBe(204);
    expect(
      (
        await call(http, 'post', '/v1/admin/kill-switch', {
          scope: 'SIGNUP',
          active: true,
        })
      ).status,
    ).toBe(204);
    const closed = await request(http)
      .post('/v1/me/disclaimer')
      .set('Authorization', await bearer(id))
      .send({ version: '2026-10-01' });
    expect(closed.status).toBe(503);
    expect(closed.body.code).toBe('KILL_SWITCH_ACTIVE');
    // An existing user re-accepting a newer disclaimer is not locked out by the sign-up switch.
    const old = await newUser();
    await sql`update profiles set disclaimer_version = '2025-01-01' where id = ${old}`;
    const again = await request(http)
      .post('/v1/me/disclaimer')
      .set('Authorization', await bearer(old))
      .send({ version: '2026-10-01' });
    expect(again.status).toBe(204);
    expect((await call(http, 'post', '/v1/admin/flags/Bad Key!', { enabled: true })).status).toBe(
      422,
    );
    const actions = await sql<{ action: string }[]>`select action from audit_log order by id`;
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['admin.flag', 'admin.kill_switch']),
    );
  });

  it('strategy versions: an invalid config is refused, a valid one is created DRAFT, activation retires the previous', async () => {
    const http = await boot();
    const [seed] = await sql<
      { config: Record<string, unknown> }[]
    >`select config from strategy_versions where status = 'ACTIVE'`;
    expect(
      (
        await call(http, 'post', '/v1/admin/strategy-versions', {
          config: { nonsense: true },
        })
      ).status,
    ).toBe(422);
    const created = await call(http, 'post', '/v1/admin/strategy-versions', {
      config: seed?.config,
      notes: 'v2 candidate',
    });
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(2);
    const [draft] = await sql<
      { status: string }[]
    >`select status from strategy_versions where id = ${created.body.id}`;
    expect(draft?.status).toBe('DRAFT');
    expect(
      (await call(http, 'post', `/v1/admin/strategy-versions/${created.body.id}/activate`)).status,
    ).toBe(204);
    const rows = await sql<
      { version: number; status: string }[]
    >`select version, status from strategy_versions order by version`;
    expect(rows).toEqual([
      { version: 1, status: 'RETIRED' },
      { version: 2, status: 'ACTIVE' },
    ]);
    // restore the seed state for the other tests in this file
    await sql`update strategy_versions set status = case when version = 1 then 'ACTIVE' else 'RETIRED' end`;
  });

  it('lists and closes data-quality incidents', async () => {
    const http = await boot();
    const [inc] = await sql<
      { id: number }[]
    >`insert into dq_incidents (rule) values ('FEED_STALE') returning id`;
    const open = await call(http, 'get', '/v1/admin/dq-incidents');
    expect(open.body.items.map((i: { id: string }) => Number(i.id))).toContain(Number(inc?.id));
    expect((await call(http, 'post', `/v1/admin/dq-incidents/${inc?.id}/close`)).status).toBe(204);
    expect((await call(http, 'post', `/v1/admin/dq-incidents/${inc?.id}/close`)).status).toBe(404);
    expect((await call(http, 'get', '/v1/admin/dq-incidents')).body.items).toEqual([]);
  });
});
