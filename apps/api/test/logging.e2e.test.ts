import type { NestExpressApplication } from '@nestjs/platform-express';
import pino from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLoggerParams } from '../src/common/logging.js';
import { createTestApp, LogSink } from './helpers.js';

let current: NestExpressApplication | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('request logging (invariants 2 and 10)', () => {
  it('logs the request once with the correlation id and none of the sensitive parts', async () => {
    const sink = new LogSink();
    const { app } = await createTestApp({ logSink: sink });
    current = app;

    const bearer = 'eyJhbGciOiJFUzI1NiJ9.super-secret-token-payload.signature-part';
    const res = await request(app.getHttpServer())
      .post('/test/echo?token=query-secret-123&email=trader@example.com')
      .set('Authorization', `Bearer ${bearer}`)
      .set('Cookie', 'session=cookie-secret-456')
      .send({ password: 'hunter2', image: 'AAAA-image-bytes', note: 'body-marker' });

    const log = sink.text;
    const entries = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const requestEntry = entries.find(
      (e) => (e.req as { path?: string } | undefined)?.path === '/test/echo',
    );

    expect(requestEntry).toBeDefined();
    expect(requestEntry?.correlationId).toBe(res.headers['x-correlation-id']);
    expect(requestEntry).toMatchObject({
      req: { method: 'POST', path: '/test/echo' },
      res: { statusCode: 201 },
    });

    for (const secret of [
      bearer,
      'super-secret-token-payload',
      'query-secret-123',
      'trader@example.com',
      'cookie-secret-456',
      'hunter2',
      'AAAA-image-bytes',
      'body-marker',
    ]) {
      expect(log).not.toContain(secret);
    }
  });

  it('redacts credentials, personal data and media buffers in any logged object', () => {
    // nestjs-pino keeps its out-of-request logger in a module global shared by every app in a process, so the
    // redaction rules are exercised on a logger built from exactly the options the app uses.
    const sink = new LogSink();
    const params = buildLoggerParams({ LOG_LEVEL: 'info' });
    const options = params.pinoHttp as { level: string; redact: pino.LoggerOptions['redact'] };
    pino({ level: options.level, redact: options.redact }, sink).info({
      authorization: 'Bearer abc',
      token: 'tok-1',
      user: {
        email: 'a@b.c',
        address: '0xAbCdEf',
        image: 'raw-pixels',
        audio: 'raw-audio',
        frame: 'f',
      },
      note: 'visible',
    });

    const text = sink.text;
    for (const secret of ['Bearer abc', 'tok-1', 'a@b.c', '0xAbCdEf', 'raw-pixels', 'raw-audio']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('visible');
    expect(text).toContain('[redacted]');
  });

  it('does not log health probes', async () => {
    const sink = new LogSink();
    const { app } = await createTestApp({ logSink: sink });
    current = app;
    await request(app.getHttpServer()).get('/healthz');
    expect(sink.text).not.toContain('/healthz');
  });
});
