import { randomUUID } from 'node:crypto';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeKeys, type TestKeys } from './helpers.js';

// Walks every /v1 route as a signed-in, fully onboarded user and checks the cross-cutting contract rules:
// errors are problem+json with a code and correlation id, nothing answers 5xx to bad input, JSON GETs carry an ETag
// that yields 304, and list endpoints reject a bad limit. Admin routes are probed as an ordinary user (expect 403).

let server: TestServer;
let sql: Sql;
let app: NestExpressApplication;
let keys: TestKeys;
let auth = '';

beforeAll(async () => {
  server = await startTestServer();
  const dbUrl = await server.createDatabase();
  sql = createClient(dbUrl, { max: 4 });
  await applyMigrations(sql, { withShims: true });
  keys = await makeKeys();
  ({ app } = await createTestApp({ keys, env: { DATABASE_URL: dbUrl } }));
  const id = randomUUID();
  await sql`insert into auth.users (id, raw_user_meta_data) values (${id}, '{}'::jsonb)`;
  await sql`update profiles set disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${id}`;
  auth = `Bearer ${await keys.sign({ sub: id })}`;
}, 180_000);
afterAll(async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  await server.stop();
});

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
interface Route {
  method: (typeof METHODS)[number];
  path: string;
}

function routes(): Route[] {
  const { Reflect: R } = globalThis as unknown as {
    Reflect: typeof Reflect & { getMetadata: (k: string, t: object) => unknown };
  };
  const out: Route[] = [];
  for (const m of app.get(ModulesContainer).values()) {
    for (const w of m.controllers.values()) {
      const cls = w.metatype as (new (...a: never[]) => object) | null;
      if (!cls) continue;
      const prefix = String(R.getMetadata('path', cls) ?? '');
      if (!prefix.startsWith('v1')) continue;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const fn = Object.getOwnPropertyDescriptor(cls.prototype, name)?.value as unknown;
        if (typeof fn !== 'function') continue;
        const method = R.getMetadata('method', fn);
        if (typeof method !== 'number') continue;
        const sub = String(R.getMetadata('path', fn) ?? '');
        const path = `/${prefix}/${sub}`.replace(/\/+/g, '/').replace(/\/$/, '');
        out.push({ method: METHODS[method] as Route['method'], path });
      }
    }
  }
  return out;
}

const fill = (path: string, id: string) => path.replace(/:[A-Za-z]+/g, id);
const isProblem = (res: request.Response) =>
  String(res.headers['content-type'] ?? '').startsWith('application/problem+json') &&
  typeof res.body.code === 'string' &&
  typeof res.body.correlationId === 'string' &&
  typeof res.body.status === 'number';

describe('contract probe', () => {
  it('finds the whole route table', () => {
    expect(routes().length).toBeGreaterThan(60);
  });

  it('never answers 5xx, and every error is problem+json, for valid ids, bad ids and empty bodies', async () => {
    const http = app.getHttpServer();
    const bad: string[] = [];
    const seen: Record<string, number> = {};
    for (const r of routes()) {
      for (const id of [randomUUID(), 'not-a-uuid']) {
        const url = fill(r.path, id);
        const call = request(http)[r.method].call(request(http), url) as request.Test;
        const res = await call.set('Authorization', auth).send(r.method === 'get' ? undefined : {});
        seen[String(res.status)] = (seen[String(res.status)] ?? 0) + 1;
        const label = `${r.method.toUpperCase()} ${url} -> ${res.status}`;
        if (res.status >= 500) bad.push(`${label} (server error)`);
        else if (res.status >= 400 && !isProblem(res)) bad.push(`${label} (not problem+json)`);
        if (id === 'not-a-uuid' && r.path.includes(':') && res.status === 200)
          bad.push(`${label} (accepted a bad id)`);
      }
    }
    console.log('status histogram', JSON.stringify(seen));
    expect(bad).toEqual([]);
  }, 120_000);

  it('admin routes refuse an ordinary user', async () => {
    const http = app.getHttpServer();
    const wrong: string[] = [];
    for (const r of routes().filter((x) => x.path.startsWith('/v1/admin'))) {
      const call = request(http)[r.method].call(
        request(http),
        fill(r.path, randomUUID()),
      ) as request.Test;
      const res = await call.set('Authorization', auth).send(r.method === 'get' ? undefined : {});
      if (res.status !== 403) wrong.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('JSON GET answers carry an ETag and honour If-None-Match', async () => {
    const http = app.getHttpServer();
    const missing: string[] = [];
    for (const path of [
      '/v1/me',
      '/v1/instruments',
      '/v1/venues',
      '/v1/journal',
      '/v1/notifications',
      '/v1/trades',
      '/v1/sessions',
      '/v1/risk-profile',
    ]) {
      const first = await request(http).get(path).set('Authorization', auth);
      if (first.status !== 200) {
        missing.push(`${path} -> ${first.status}`);
        continue;
      }
      const tag = first.headers.etag;
      if (!tag) {
        missing.push(`${path} has no ETag`);
        continue;
      }
      const again = await request(http)
        .get(path)
        .set('Authorization', auth)
        .set('If-None-Match', tag);
      if (again.status !== 304) missing.push(`${path} If-None-Match -> ${again.status}`);
    }
    expect(missing).toEqual([]);
  });

  it('list endpoints reject a bad limit and return a cursor field', async () => {
    const http = app.getHttpServer();
    const wrong: string[] = [];
    for (const path of ['/v1/journal', '/v1/notifications', '/v1/trades', '/v1/sessions']) {
      for (const limit of ['0', '-1', 'abc', '100000']) {
        const res = await request(http).get(`${path}?limit=${limit}`).set('Authorization', auth);
        if (res.status === 200) {
          if (limit !== '100000') wrong.push(`${path}?limit=${limit} accepted`);
        } else if (res.status >= 500 || !isProblem(res))
          wrong.push(`${path}?limit=${limit} -> ${res.status}`);
      }
      const ok = await request(http).get(`${path}?limit=5`).set('Authorization', auth);
      if (ok.status !== 200 || !Array.isArray(ok.body.items) || !('nextCursor' in ok.body)) {
        wrong.push(`${path} list shape`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
