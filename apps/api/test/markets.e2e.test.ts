import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeKeys, type TestKeys } from './helpers.js';

let server: TestServer;
let sql: Sql;
let dbUrl: string;
let keys: TestKeys;
const apps: NestExpressApplication[] = [];

beforeAll(async () => {
  server = await startTestServer();
  dbUrl = await server.createDatabase();
  sql = createClient(dbUrl, { max: 4 });
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

async function boot(env: Record<string, string> = {}) {
  const { app } = await createTestApp({ keys, env: { DATABASE_URL: dbUrl, ...env } });
  apps.push(app);
  return app.getHttpServer();
}
const user = async () => `Bearer ${await keys.sign()}`;
const admin = async () =>
  `Bearer ${await keys.sign({ claims: { app_metadata: { role: 'admin' } } })}`;
const adminGet = async (path: string, extra: Record<string, string> = {}) =>
  request(await boot())
    .get(path)
    .set('Authorization', await admin())
    .set('X-Admin-Confirm', 'yes')
    .set(extra);

const idOf = async (canonical: string) => {
  const [row] = await sql<
    { id: string }[]
  >`select id from instruments where canonical = ${canonical}`;
  return row?.id ?? '';
};

describe('public status', () => {
  it('answers without a token and says ingest is off when it is not running', async () => {
    const res = await request(await boot()).get('/v1/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ingest: 'DISABLED', feeds: { total: 0 } });
  });
});

describe('instruments', () => {
  it('requires a token', async () => {
    expect((await request(await boot()).get('/v1/instruments')).status).toBe(401);
  });

  it('lists the six Binance series, never the cross-check venue, never forex, and never offers raw data by default', async () => {
    const res = await request(await boot())
      .get('/v1/instruments')
      .set('Authorization', await user());
    expect(res.status).toBe(200);
    const canon = res.body.items.map((i: { canonical: string }) => i.canonical);
    expect(canon).toEqual([
      'BINANCE:PERP:BTCUSDT',
      'BINANCE:PERP:ETHUSDT',
      'BINANCE:PERP:SOLUSDT',
      'BINANCE:SPOT:BTCUSDT',
      'BINANCE:SPOT:ETHUSDT',
      'BINANCE:SPOT:SOLUSDT',
    ]);
    for (const i of res.body.items) {
      expect(i).toMatchObject({
        assetClass: 'CRYPTO',
        licenseClass: 'INTERNAL_ONLY',
        rawDataAllowed: false,
      });
    }
  });

  it('returns one instrument, 404 for an unknown or cross-check one, 422 for a malformed id', async () => {
    const http = await boot();
    const auth = await user();
    const id = await idOf('BINANCE:PERP:BTCUSDT');
    expect(
      (await request(http).get(`/v1/instruments/${id}`).set('Authorization', auth)).body.canonical,
    ).toBe('BINANCE:PERP:BTCUSDT');
    expect(
      (
        await request(http)
          .get('/v1/instruments/00000000-0000-4000-8000-000000000000')
          .set('Authorization', auth)
      ).status,
    ).toBe(404);
    const bybit = await idOf('BYBIT:PERP:BTCUSDT');
    expect(
      (await request(http).get(`/v1/instruments/${bybit}`).set('Authorization', auth)).status,
    ).toBe(404);
    expect(
      (await request(http).get('/v1/instruments/not-a-uuid').set('Authorization', auth)).status,
    ).toBe(422);
  });

  it('reports UNKNOWN feed status when ingest is not running', async () => {
    const id = await idOf('BINANCE:PERP:BTCUSDT');
    const res = await request(await boot())
      .get(`/v1/instruments/${id}/status`)
      .set('Authorization', await user());
    expect(res.body).toMatchObject({ instrumentId: id, state: 'UNKNOWN' });
  });
});

describe('resolve', () => {
  it('BTCUSDT.P on Binance resolves to the perp, unambiguously', async () => {
    const res = await request(await boot())
      .get('/v1/instruments/resolve?q=BTCUSDT.P&venue=BINANCE')
      .set('Authorization', await user());
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].instrument.canonical).toBe('BINANCE:PERP:BTCUSDT');
    expect(res.body.ambiguous).toBe(false);
    // Resolution may use stored prices internally but never returns one (licence: no raw prices without evidence).
    expect(JSON.stringify(res.body)).not.toMatch(/lastPrice|"price"|"close"/);
  });

  it('a bare BTCUSDT is ambiguous between spot and perp and says so', async () => {
    const res = await request(await boot())
      .get('/v1/instruments/resolve?q=BTCUSDT')
      .set('Authorization', await user());
    expect(
      res.body.candidates
        .map((c: { instrument: { marketType: string } }) => c.instrument.marketType)
        .sort(),
    ).toEqual(['PERP', 'SPOT']);
    expect(res.body.ambiguous).toBe(true);
  });

  it('XBT/USD style input maps to the same asset and unknown symbols return nothing', async () => {
    const http = await boot();
    const auth = await user();
    expect(
      (await request(http).get('/v1/instruments/resolve?q=DOGEUSDT').set('Authorization', auth))
        .body.candidates,
    ).toEqual([]);
    expect(
      (await request(http).get('/v1/instruments/resolve').set('Authorization', auth)).status,
    ).toBe(422);
  });

  it('uses the last price to separate assets', async () => {
    const res = await request(await boot())
      .get('/v1/instruments/resolve?q=ETHUSDT&price=99999')
      .set('Authorization', await user());
    expect(res.status).toBe(200);
  });
});

describe('licence gating of raw candles (invariant 6)', () => {
  const MIN = 60_000;
  const base = Date.UTC(2026, 9, 11, 12, 0);

  it('refuses every listed instrument by default with FEED_LICENSE_RESTRICTED', async () => {
    const http = await boot();
    const auth = await user();
    for (const canonical of [
      'BINANCE:SPOT:BTCUSDT',
      'BINANCE:PERP:ETHUSDT',
      'BINANCE:PERP:SOLUSDT',
    ]) {
      const id = await idOf(canonical);
      const res = await request(http)
        .get(`/v1/instruments/${id}/candles?tf=1m`)
        .set('Authorization', auth);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FEED_LICENSE_RESTRICTED');
    }
  });

  it('opens only after a DISPLAY_OK venue_terms row exists, and closes again when a later row prohibits it', async () => {
    const id = await idOf('BINANCE:PERP:BTCUSDT');
    await sql`truncate candles`;
    for (let m = 0; m < 3; m++) {
      await sql`insert into candles (instrument_id, tf, open_time, o, h, l, c, v, provider_id, status, flags)
                values (${id}, '1m', ${new Date(base + m * MIN)}, 1, 2, 0.5, 1.5, 3, 'binance', 'CLOSED', 0)`;
    }
    const http = await boot();
    const auth = await user();
    const adminAuth = await admin();
    const terms = (decision: string) =>
      request(http)
        .post('/v1/admin/venues/BINANCE/terms')
        .set('Authorization', adminAuth)
        .set('X-Admin-Confirm', 'yes')
        .send({
          url: 'https://example.invalid/terms',
          retrievedAt: '2026-10-11',
          summary: 'Test evidence for the licence view.',
          decision,
          reviewer: 'owner',
        });

    expect(
      (await request(http).get(`/v1/instruments/${id}/candles?tf=1m`).set('Authorization', auth))
        .status,
    ).toBe(403);
    expect((await terms('DISPLAY_OK')).status).toBe(201);
    const open = await request(http)
      .get(`/v1/instruments/${id}/candles?tf=1m&limit=2`)
      .set('Authorization', auth);
    expect(open.status).toBe(200);
    expect(open.body.items).toHaveLength(2);
    expect(open.body.items.map((c: { openTime: string }) => c.openTime)).toEqual([
      new Date(base + MIN).toISOString(),
      new Date(base + 2 * MIN).toISOString(),
    ]);

    await new Promise((r) => setTimeout(r, 20)); // reviewed_at orders the evidence
    expect((await terms('PROHIBITED')).status).toBe(201);
    expect(
      (await request(http).get(`/v1/instruments/${id}/candles?tf=1m`).set('Authorization', auth))
        .status,
    ).toBe(403);
    await sql`delete from venue_terms`;
  });

  it("a DISPLAY_OK decision for one venue never opens another venue's instruments", async () => {
    await sql`insert into venue_terms (venue_id, url, retrieved_at, summary, decision, reviewer) values ('BINANCE', 'https://example.invalid', '2026-10-11', 'x', 'DISPLAY_OK', 'o')`;
    const bybit = await idOf('BYBIT:PERP:BTCUSDT'); // seeded INTERNAL_ONLY
    const res = await request(await boot())
      .get(`/v1/instruments/${bybit}/candles?tf=1m`)
      .set('Authorization', await user());
    expect(res.status).toBe(403);
    await sql`delete from venue_terms`;
  });

  it('rejects a malformed candles query', async () => {
    const id = await idOf('BINANCE:PERP:BTCUSDT');
    await sql`insert into venue_terms (venue_id, url, retrieved_at, summary, decision, reviewer) values ('BINANCE', 'https://example.invalid', '2026-10-11', 'x', 'DISPLAY_OK', 'o')`;
    const http = await boot();
    const auth = await user();
    expect(
      (await request(http).get(`/v1/instruments/${id}/candles?tf=7m`).set('Authorization', auth))
        .status,
    ).toBe(422);
    expect(
      (
        await request(http)
          .get(`/v1/instruments/${id}/candles?tf=1m&limit=5000`)
          .set('Authorization', auth)
      ).status,
    ).toBe(422);
    await sql`delete from venue_terms`;
  });

  it('route scan: candle reads exist only in the licence-guarded controller method', () => {
    const root = join(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const callers = files.filter((f) => /\.candles\(/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => f.replace(root, '').replaceAll('\\', '/'))).toEqual([
      '/markets/markets.controller.ts',
    ]);
    const controller = readFileSync(join(root, 'markets/markets.controller.ts'), 'utf8');
    const match = /@UseGuards\(([^)]*)\)\s*@Get\('instruments\/:id\/candles'\)/.exec(controller);
    expect(match?.[1]).toContain('LicenseGuard');
  });
});

describe('admin access class', () => {
  it('refuses a normal user, and an admin without the confirmation header', async () => {
    const http = await boot();
    const asUser = await request(http)
      .get('/v1/admin/feeds')
      .set('Authorization', await user())
      .set('X-Admin-Confirm', 'yes');
    expect(asUser.status).toBe(403);
    const noHeader = await request(http)
      .get('/v1/admin/feeds')
      .set('Authorization', await admin());
    expect(noHeader.status).toBe(403);
    expect((await request(http).get('/v1/admin/feeds')).status).toBe(401);
  });

  it('shows feed health to an admin', async () => {
    const res = await adminGet('/v1/admin/feeds');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ingest: 'DISABLED', providers: [], feeds: [] });
  });

  it('enforces the source-address allow-list, including CIDR ranges', async () => {
    const http = await boot({ ADMIN_IP_ALLOWLIST: '203.0.113.0/24,2001:db8::1' });
    const call = (ip: string) =>
      request(http)
        .get('/v1/admin/feeds')
        .set('Authorization', `Bearer ${tokenAdmin}`)
        .set('X-Admin-Confirm', 'yes')
        .set('CF-Connecting-IP', ip);
    const tokenAdmin = await keys.sign({ claims: { app_metadata: { role: 'admin' } } });
    expect((await call('203.0.113.77')).status).toBe(200);
    expect((await call('2001:db8::1')).status).toBe(200);
    expect((await call('198.51.100.1')).status).toBe(403);
    expect((await call('not-an-ip')).status).toBe(403);
  });

  it('validates terms input and writes an audit row; unknown venue is 404', async () => {
    const http = await boot();
    const auth = await admin();
    const post = (venue: string, body: object) =>
      request(http)
        .post(`/v1/admin/venues/${venue}/terms`)
        .set('Authorization', auth)
        .set('X-Admin-Confirm', 'yes')
        .send(body);
    expect((await post('BINANCE', { decision: 'DISPLAY_OK' })).status).toBe(422);
    expect(
      (
        await post('BINANCE', {
          url: 'https://x.invalid',
          retrievedAt: '2026-10-11',
          summary: 'long enough summary',
          decision: 'YES',
          reviewer: 'o',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post('NOPE', {
          url: 'https://x.invalid',
          retrievedAt: '2026-10-11',
          summary: 'long enough summary',
          decision: 'INTERNAL_ONLY',
          reviewer: 'o',
        })
      ).status,
    ).toBe(404);
    const ok = await post('BYBIT', {
      url: 'https://x.invalid',
      retrievedAt: '2026-10-11',
      summary: 'long enough summary',
      decision: 'INTERNAL_ONLY',
      reviewer: 'owner',
      counselReviewed: false,
    });
    expect(ok.status).toBe(201);
    const [audit] = await sql<
      { action: string; target: string }[]
    >`select action, target from audit_log order by id desc limit 1`;
    expect(audit).toMatchObject({ action: 'admin.venue_terms', target: 'BYBIT' });
    await sql`delete from venue_terms`;
  });

  it('patches venue flags and audits it', async () => {
    const http = await boot();
    const auth = await admin();
    const patch = (body: object) =>
      request(http)
        .patch('/v1/admin/venues/BYBIT')
        .set('Authorization', auth)
        .set('X-Admin-Confirm', 'yes')
        .send(body);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ enabled: 'yes' })).status).toBe(422);
    expect((await patch({ crosscheckEnabled: true })).status).toBe(200);
    const [v] = await sql<
      { crosscheck_enabled: boolean }[]
    >`select crosscheck_enabled from venues where id = 'BYBIT'`;
    expect(v?.crosscheck_enabled).toBe(true);
    await sql`update venues set crosscheck_enabled = true where id = 'BYBIT'`;
  });
});
