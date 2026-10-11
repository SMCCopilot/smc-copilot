import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiProblemSchema } from '@smc/contracts';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeKeys, type TestKeys } from './helpers.js';

let keys: TestKeys;
beforeAll(async () => {
  keys = await makeKeys();
});

const apps: NestExpressApplication[] = [];
async function server(withKeys = true) {
  const { app } = await createTestApp(withKeys ? { keys } : {});
  apps.push(app);
  return app.getHttpServer();
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const get = async (token?: string, withKeys = true) => {
  const req = request(await server(withKeys)).get('/test/protected');
  return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
};

describe('JwtAuthGuard', () => {
  it('accepts a valid token', async () => {
    const res = await get(await keys.sign());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('answers a missing header with problem+json AUTH_REQUIRED (A10 M0 AC2)', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(ApiProblemSchema.parse(res.body)).toMatchObject({ code: 'AUTH_REQUIRED', status: 401 });
  });

  it.each([
    ['garbage', 'not-a-jwt'],
    ['empty bearer', ''],
  ])('rejects %s', async (_label, token) => {
    const res = await request(await server())
      .get('/test/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a non-bearer scheme', async () => {
    const res = await request(await server())
      .get('/test/protected')
      .set('Authorization', `Basic ${Buffer.from('a:b').toString('base64')}`);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('reports an expired token as TOKEN_EXPIRED so clients can sign in again', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await keys.sign({ issuedAt: now - 600, expiresIn: now - 300 });
    const res = await get(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }],
    ['wrong issuer', { iss: 'https://evil.example/auth/v1' }],
    ['unknown signing key id', { kid: 'other-key' }],
  ])('rejects a token with a %s without saying why', async (_label, override) => {
    const res = await get(await keys.sign(override));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(JSON.stringify(res.body)).not.toMatch(/audience|issuer|kid/i);
  });

  it('rejects a token signed by a different key', async () => {
    const other = await makeKeys();
    const res = await get(await other.sign());
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects HS256 tokens (shared-secret algorithms are not accepted)', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('u')
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length'));
    expect((await get(token)).body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects an unsigned alg=none token', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'none' })}.${b64({ sub: 'u', aud: 'authenticated', exp: 9999999999, iat: 1 })}.`;
    expect((await get(token)).body.code).toBe('AUTH_REQUIRED');
  });

  it('fails closed when JWT verification is not configured', async () => {
    const res = await get(await keys.sign(), false);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });
});
