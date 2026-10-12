import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisService } from '../src/analysis/analysis.service.js';
import { EVENT_BUS } from '../src/config/tokens.js';
import type { EventBus } from '../src/ingest/event-bus.js';
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
  sql = createClient(dbUrl, { max: 10 });
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
  await sql`delete from copilot_sessions`;
  await sql`delete from workspaces`;
  await sql`delete from auth.users`;
});

const percentile = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] ?? 0;

/**
 * B05 week 16, day 4: twenty sessions on one instrument while the engine publishes updates. The model is mocked (no
 * provider is enabled), so this measures the realtime path alone: update to overlay at the 95th percentile under 500 ms,
 * and no gaps in any session's sequence numbers.
 */
describe('20-session smoke', () => {
  it('delivers every update to every session in order, fast', async () => {
    const { app } = await createTestApp({
      keys,
      env: { DATABASE_URL: dbUrl, WS_TOKEN_SECRET: 'x'.repeat(40) },
    });
    apps.push(app);
    let version = 0;
    const published: number[] = [];
    app.get(AnalysisService).snapshot = (async () => ({
      snapshotId: `v${version}`,
      asOf: new Date().toISOString(),
      instrumentId: 'BINANCE:PERP:BTCUSDT',
      strategyVersionId: 'sv',
      dataQuality: 'OK',
      warnings: [],
      htfBias: { tf: '4h', trend: 'BULL', lastBreak: null },
    })) as never;
    await app.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const inst = (
      await sql<
        { id: string; canonical: string }[]
      >`select id, canonical from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`
    )[0];

    const N = 20;
    const UPDATES = 25;
    const clients: { s: Socket; seqs: number[]; recv: Map<string, number> }[] = [];
    for (let i = 0; i < N; i++) {
      const id = randomUUID();
      await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
      await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
      const auth = `Bearer ${await keys.sign({ sub: id })}`;
      const created = await request(app.getHttpServer())
        .post('/v1/sessions')
        .set('Authorization', auth)
        .set('Idempotency-Key', randomUUID())
        .send({ instrumentId: inst?.id });
      const s = connect(url, {
        path: '/ws',
        auth: { wsToken: created.body.wsToken },
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(s);
      const c = { s, seqs: [] as number[], recv: new Map<string, number>() };
      clients.push(c);
      for (const ev of [
        'session.state',
        'analysis.update',
        'setup.event',
        'narrative.done',
        'warning',
        'context.updated',
        'feed.status',
      ]) {
        s.on(ev, (e: { seq: number; payload?: { snapshotId?: string } }) => {
          c.seqs.push(e.seq);
          if (ev === 'analysis.update' && e.payload?.snapshotId)
            c.recv.set(e.payload.snapshotId, performance.now());
        });
      }
      await new Promise<void>((res) => s.once('connect', () => res()));
      s.emit('session.start', { sessionId: created.body.sessionId });
    }
    await new Promise((r) => setTimeout(r, 800)); // everyone has started

    const bus = app.get<EventBus>(EVENT_BUS);
    const sentAt = new Map<string, number>();
    for (let k = 1; k <= UPDATES; k++) {
      version = k;
      sentAt.set(`v${k}`, performance.now());
      published.push(k);
      bus.publish('engine.updated', {
        instrumentId: inst?.id as string,
        canonical: inst?.canonical as string,
        asOf: Date.now(),
        events: 1,
        rebuilt: false,
      });
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 1500));

    const latencies: number[] = [];
    for (const c of clients) {
      // Every update reached every session.
      for (let k = 1; k <= UPDATES; k++) expect(c.recv.has(`v${k}`), `v${k}`).toBe(true);
      for (let k = 1; k <= UPDATES; k++)
        latencies.push((c.recv.get(`v${k}`) as number) - (sentAt.get(`v${k}`) as number));
      // Sequence numbers rise by exactly one: nothing dropped, nothing out of order.
      const sorted = c.seqs;
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]).toBe((sorted[i - 1] as number) + 1);
    }
    const p95 = percentile(latencies, 95);
    console.log(
      `20-session smoke: ${latencies.length} deliveries, p50 ${percentile(latencies, 50).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
    );
    expect(p95).toBeLessThan(500);
    expect(published).toHaveLength(UPDATES);
  }, 120_000);
});
