import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiProblemSchema } from '@smc/contracts';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, LogSink } from './helpers.js';

const apps: NestExpressApplication[] = [];
async function app(options?: Parameters<typeof createTestApp>[0]) {
  const created = await createTestApp(options);
  apps.push(created.app);
  return created.app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('GET /healthz', () => {
  it('is 200 with no database configured (liveness never touches a dependency)', async () => {
    const res = await request((await app()).getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('sends security headers and does not advertise the framework', async () => {
    const res = await request((await app()).getHttpServer()).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('correlation id', () => {
  it('generates one and returns it', async () => {
    const res = await request((await app()).getHttpServer()).get('/healthz');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps a well-formed client id', async () => {
    const res = await request((await app()).getHttpServer())
      .get('/healthz')
      .set('X-Correlation-Id', 'client-trace-0001');
    expect(res.headers['x-correlation-id']).toBe('client-trace-0001');
  });

  it.each(['short', 'has spaces in it', 'x'.repeat(65), 'bad<script>chars_here'])(
    'replaces the unsafe client id %j',
    async (bad) => {
      const res = await request((await app()).getHttpServer())
        .get('/healthz')
        .set('X-Correlation-Id', bad);
      expect(res.headers['x-correlation-id']).not.toBe(bad);
      expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});

describe('problem+json', () => {
  it('answers an unknown route with a catalogue problem and the correlation id', async () => {
    const res = await request((await app()).getHttpServer()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(ApiProblemSchema.parse(res.body)).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('answers malformed JSON with VALIDATION_FAILED and does not echo the body', async () => {
    const res = await request((await app()).getHttpServer())
      .post('/test/echo')
      .set('Content-Type', 'application/json')
      .send('{"password": "hunter2",');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('rejects bodies over 64 KB with PAYLOAD_TOO_LARGE', async () => {
    const res = await request((await app()).getHttpServer())
      .post('/test/echo')
      .send({ filler: 'x'.repeat(70_000) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.headers['content-type']).toMatch(/problem\+json/);
  });

  it('hides internals on an unexpected error and logs them for the operator instead', async () => {
    const sink = new LogSink();
    const res = await request((await app({ logSink: sink })).getHttpServer()).get('/test/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL', status: 500 });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|db\.internal|connection/);
    expect(sink.text).toContain('unhandled exception');
    expect(sink.text).toContain(res.body.correlationId);
  });
});

describe('CORS', () => {
  it('sends no CORS headers when no origin is configured', async () => {
    const res = await request((await app()).getHttpServer())
      .get('/healthz')
      .set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows exactly the configured origins', async () => {
    const server = (await app({ env: { CORS_ORIGINS: 'https://app.example' } })).getHttpServer();
    const ok = await request(server).get('/healthz').set('Origin', 'https://app.example');
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example');
    const bad = await request(server).get('/healthz').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('GET /readyz', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  }, 180_000);
  afterAll(async () => {
    await server.stop();
  });

  it('is 503 NOT_READY when no database is configured', async () => {
    const res = await request((await app()).getHttpServer()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'NOT_READY', extras: { checks: { database: 'fail' } } });
  });

  it('is 503 when the database is unreachable, within the check timeout', async () => {
    const started = Date.now();
    const res = await request(
      (await app({ env: { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none' } })).getHttpServer(),
    ).get('/readyz');
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('is 200 with a reachable database, proving the transaction-pooler-safe self test', async () => {
    const url = await server.createDatabase();
    const res = await request((await app({ env: { DATABASE_URL: url } })).getHttpServer()).get(
      '/readyz',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });
});
