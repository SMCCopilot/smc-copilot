import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createClient } from '@smc/db';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseJwtAuthProvider } from '../src/auth/supabase-jwt.provider.js';
import { type ReadinessCheck, ReadinessService } from '../src/health/readiness.js';
import { AUDIENCE, createTestApp, ISSUER, LogSink, makeKeys, type TestKeys } from './helpers.js';

const apps: NestExpressApplication[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
const boot = async (options?: Parameters<typeof createTestApp>[0]) => {
  const { app } = await createTestApp(options);
  apps.push(app);
  return app.getHttpServer();
};

let keys: TestKeys;
beforeAll(async () => {
  keys = await makeKeys();
});

describe('error logging never carries the error message or properties (H1)', () => {
  it('logs type and frames for an unexpected error, but not what the error says', async () => {
    const sink = new LogSink();
    const res = await request(await boot({ logSink: sink })).get('/test/boom');
    expect(res.status).toBe(500);
    expect(sink.text).toContain('unhandled exception');
    expect(sink.text).toContain(res.body.correlationId);
    for (const secret of ['hunter2', 'db.internal', 'connection to']) {
      expect(sink.text).not.toContain(secret);
    }
  });
});

describe('correlation id survives rejected bodies (M1)', () => {
  it.each([
    ['413 too large', () => ({ filler: 'x'.repeat(70_000) }), 413],
    ['malformed JSON', () => '{"a":', 422],
  ])('%s keeps the client id in header and body', async (_label, body, status) => {
    const res = await request(await boot())
      .post('/test/echo')
      .set('X-Correlation-Id', 'client-trace-0001')
      .set('Content-Type', 'application/json')
      .send(typeof body() === 'string' ? (body() as string) : JSON.stringify(body()));
    expect(res.status).toBe(status);
    expect(res.headers['x-correlation-id']).toBe('client-trace-0001');
    expect(res.body.correlationId).toBe('client-trace-0001');
  });
});

describe('body size limits (M2)', () => {
  it('applies the 64 KB limit to urlencoded bodies too', async () => {
    const res = await request(await boot())
      .post('/test/echo')
      .type('form')
      .send(`a=${'x'.repeat(90_000)}`);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('token rules', () => {
  const server = async () => boot({ keys });

  it.each([
    ['anonymous user', { claims: { is_anonymous: true } }],
    ['service role claim', { claims: { role: 'service_role' } }],
    ['issued in the future', { issuedAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: '2h' }],
  ])('rejects a token for an %s', async (_label, override) => {
    const res = await request(await server())
      .get('/test/protected')
      .set('Authorization', `Bearer ${await keys.sign(override)}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('accepts an authenticated-role token and a lower-case scheme, and 401s advertise Bearer', async () => {
    const ok = await request(await server())
      .get('/test/protected')
      .set('Authorization', `bearer ${await keys.sign({ claims: { role: 'authenticated' } })}`);
    expect(ok.status).toBe(200);
    const bad = await request(await server()).get('/test/protected');
    expect(bad.headers['www-authenticate']).toBe('Bearer');
  });

  it('refuses HS256 even when the key source would hand out a matching secret (algorithm allow-list)', async () => {
    const secret = new TextEncoder().encode('a-shared-secret-of-sufficient-length');
    const provider = new SupabaseJwtAuthProvider({
      getKey: async () => secret, // a lax key source: only the algorithm allow-list can stop this
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setAudience(AUDIENCE)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    await expect(provider.verifyToken(token)).rejects.toMatchObject({ failure: 'INVALID' });
  });
});

describe('production auth wiring (T4, M5)', () => {
  const jwks = (): Promise<{ url: string }> =>
    new Promise((resolve) => {
      const s = createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [keys.jwk] }));
      });
      servers.push(s);
      s.listen(0, '127.0.0.1', () =>
        resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/jwks` }),
      );
    });

  it('verifies against a remote JWKS and derives the issuer from SUPABASE_URL', async () => {
    const { url } = await jwks();
    const server = await boot({
      env: { SUPABASE_JWKS_URL: url, SUPABASE_URL: 'https://test.supabase.example' },
    });
    const good = await request(server)
      .get('/test/protected')
      .set('Authorization', `Bearer ${await keys.sign()}`);
    expect(good.status).toBe(200);
    const wrongIssuer = await request(server)
      .get('/test/protected')
      .set('Authorization', `Bearer ${await keys.sign({ iss: 'https://evil.example/auth/v1' })}`);
    expect(wrongIssuer.body.code).toBe('AUTH_REQUIRED');
  });

  it('answers 503 AUTH_UNAVAILABLE, not 401, when the key set cannot be fetched', async () => {
    const server = await boot({
      env: {
        SUPABASE_JWKS_URL: 'http://127.0.0.1:1/jwks',
        SUPABASE_URL: 'https://test.supabase.example',
      },
    });
    const res = await request(server)
      .get('/test/protected')
      .set('Authorization', `Bearer ${await keys.sign()}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('readiness is single-flight and cached (M6)', () => {
  it('runs a check once for many concurrent probes', async () => {
    let runs = 0;
    const check: ReadinessCheck = {
      name: 'slow',
      run: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 50));
      },
    };
    const service = new ReadinessService([check]);
    const reports = await Promise.all(Array.from({ length: 50 }, () => service.report()));
    expect(runs).toBe(1);
    expect(reports.every((r) => r.ready)).toBe(true);
    await service.report();
    expect(runs).toBe(1); // still inside the cache window
  });

  it('reports a hanging check as failed within the timeout', async () => {
    const service = new ReadinessService([{ name: 'hang', run: () => new Promise(() => {}) }]);
    const started = Date.now();
    const report = await service.report();
    expect(report).toEqual({ ready: false, checks: { hang: 'fail' } });
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('database client (T2)', () => {
  it('disables prepared statements, as the transaction pooler requires', async () => {
    const sql = createClient('postgres://u:p@127.0.0.1:1/none');
    expect(sql.options.prepare).toBe(false);
    await sql.end({ timeout: 1 });
  });
});
