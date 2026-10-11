import { randomUUID } from 'node:crypto';
import { ModulesContainer } from '@nestjs/core';
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
  await sql`delete from journal_entries`;
  await sql`delete from notifications`;
  await sql`delete from user_feedback`;
  await sql`delete from workspaces`;
  await sql`delete from auth.users`;
});

async function boot(env: Record<string, string> = {}) {
  const { app } = await createTestApp({ keys, env: { DATABASE_URL: dbUrl, ...env } });
  apps.push(app);
  return app;
}
async function readyUser() {
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  return { id, auth: `Bearer ${await keys.sign({ sub: id })}` };
}

/** Every route under /v1 must sit behind a guard, except the explicit public ones. */
const PUBLIC = new Set(['status']);

describe('route inventory', () => {
  it('every /v1 route has an auth guard; the raw candles route also has the licence guard', async () => {
    const app = await boot();
    const { Reflect: R } = globalThis as unknown as {
      Reflect: typeof Reflect & { getMetadata: (k: string, t: object) => unknown };
    };
    const modules = app.get(ModulesContainer);
    const unguarded: string[] = [];
    let candlesLicensed = false;
    let seen = 0;
    for (const m of modules.values()) {
      for (const w of m.controllers.values()) {
        const cls = w.metatype as (new (...a: never[]) => object) | null;
        if (!cls) continue;
        const prefix = String(R.getMetadata('path', cls) ?? '');
        if (!prefix.startsWith('v1')) continue;
        const classGuards = (R.getMetadata('__guards__', cls) as unknown[] | undefined) ?? [];
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          const fn = Object.getOwnPropertyDescriptor(cls.prototype, name)?.value as unknown;
          if (typeof fn !== 'function' || R.getMetadata('method', fn) === undefined) continue;
          seen++;
          const sub = String(R.getMetadata('path', fn) ?? '');
          const guards = [
            ...classGuards,
            ...((R.getMetadata('__guards__', fn) as unknown[] | undefined) ?? []),
          ];
          const label = `${prefix}/${sub}`;
          if (guards.length === 0 && !PUBLIC.has(sub)) unguarded.push(label);
          if (
            label.endsWith('candles') &&
            guards.some((g) => (g as { name?: string }).name === 'LicenseGuard')
          ) {
            candlesLicensed = true;
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(40);
    expect(unguarded).toEqual([]);
    expect(candlesLicensed).toBe(true);
  });
});

describe('dev client', () => {
  it('is absent unless enabled, then serves the page and the public config', async () => {
    const off = await boot();
    expect((await request(off.getHttpServer()).get('/dev')).status).toBe(404);
    expect((await request(off.getHttpServer()).get('/dev/config')).status).toBe(404);
    const on = await boot({
      DEV_CLIENT_ENABLED: 'true',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'public-anon',
    });
    const page = await request(on.getHttpServer()).get('/dev');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain('cdn.jsdelivr.net');
    expect(page.text).toContain('SMC Copilot');
    expect((await request(on.getHttpServer()).get('/dev/config')).body).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      anonKey: 'public-anon',
    });
  });
});

describe('journal, notifications and feedback', () => {
  it('keeps notes private to the workspace, edits only the user words, and withholds a small-n win rate', async () => {
    const app = await boot();
    const http = app.getHttpServer();
    const a = await readyUser();
    const b = await readyUser();
    const note = await request(http)
      .post('/v1/journal/notes')
      .set('Authorization', a.auth)
      .send({ notes: 'plan was clear', tags: ['calm'] });
    expect(note.status).toBe(201);
    expect(
      (await request(http).get('/v1/journal').set('Authorization', b.auth)).body.items,
    ).toEqual([]);
    expect(
      (
        await request(http)
          .patch(`/v1/journal/${note.body.id}`)
          .set('Authorization', b.auth)
          .send({ notes: 'x' })
      ).status,
    ).toBe(404);
    const edited = await request(http)
      .patch(`/v1/journal/${note.body.id}`)
      .set('Authorization', a.auth)
      .send({ tags: ['calm', 'patient'] });
    expect(edited.body.tags).toEqual(['calm', 'patient']);
    expect(
      (await request(http).get('/v1/journal?tag=patient').set('Authorization', a.auth)).body.items,
    ).toHaveLength(1);
    const sum = await request(http).get('/v1/journal/summary').set('Authorization', a.auth);
    expect(sum.body.winRate).toBeNull();
    expect(sum.body.winRateReason).toBe('INSUFFICIENT_HISTORY');
  });

  it('refuses a note that looks like a seed phrase and stores nothing', async () => {
    const app = await boot();
    const a = await readyUser();
    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const r = await request(app.getHttpServer())
      .post('/v1/journal/notes')
      .set('Authorization', a.auth)
      .send({ notes: phrase, tags: [] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SECRET_DETECTED');
    expect(JSON.stringify(r.body)).not.toContain('abandon');
    expect((await sql`select 1 from journal_entries`).length).toBe(0);
  });

  it('lists and marks notifications read for their owner only; feedback is stored', async () => {
    const app = await boot();
    const http = app.getHttpServer();
    const a = await readyUser();
    const b = await readyUser();
    const [w] = await sql<
      { workspace_id: string }[]
    >`select workspace_id from workspace_members where user_id = ${a.id} limit 1`.catch(() => []);
    const ws =
      w?.workspace_id ?? (await sql<{ id: string }[]>`select id from workspaces limit 1`)[0]?.id;
    const [n] = await sql<{ id: string }[]>`
      insert into notifications (workspace_id, user_id, channel, type, payload, status) values (${ws as string}, ${a.id}, 'IN_APP', 'position.near_stop', '{}'::jsonb, 'SENT') returning id`;
    expect(
      (await request(http).get('/v1/notifications?unread=true').set('Authorization', a.auth)).body
        .items,
    ).toHaveLength(1);
    expect(
      (await request(http).post(`/v1/notifications/${n?.id}/read`).set('Authorization', b.auth))
        .status,
    ).toBe(404);
    expect(
      (await request(http).post(`/v1/notifications/${n?.id}/read`).set('Authorization', a.auth))
        .status,
    ).toBe(204);
    expect(
      (await request(http).get('/v1/notifications?unread=true').set('Authorization', a.auth)).body
        .items,
    ).toHaveLength(0);
    expect(
      (
        await request(http)
          .post('/v1/feedback')
          .set('Authorization', a.auth)
          .send({ targetType: 'setup', targetId: 'abc', rating: 1 })
      ).status,
    ).toBe(204);
    expect((await sql`select 1 from user_feedback`).length).toBe(1);
  });
});
