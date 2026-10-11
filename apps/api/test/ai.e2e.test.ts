import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  LlmError,
  LlmRouter,
  PriceTable,
  type ProviderAdapter,
  type ProviderCallArgs,
  type ProviderId,
} from '@smc/ai';
import { NarrativeResponseSchema } from '@smc/contracts';
import { applyMigrations, createClient, type Sql } from '@smc/db';
import { startTestServer, type TestServer } from '@smc/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiMeterService } from '../src/ai/ai-meter.service.js';
import { NarrativeService } from '../src/ai/narrative.service.js';
import { ProviderConfigService } from '../src/ai/provider-config.service.js';
import { AnalysisService } from '../src/analysis/analysis.service.js';
import { LLM_ROUTER } from '../src/config/tokens.js';
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
  const sub = '11111111-1111-1111-1111-111111111111';
  await sql`insert into auth.users (id, raw_user_meta_data) values (${sub}, '{}'::jsonb)`;
  await sql`update profiles set invite_redeemed_at = now(), disclaimer_version = '2026-10-01', disclaimer_accepted_at = now(), age_confirmed_at = now() where id = ${sub}`;
}, 180_000);
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await server.stop();
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
beforeEach(async () => {
  await sql`delete from ai_calls`;
  await sql`delete from narratives`;
  await sql`delete from ai_global_ledger`;
  await sql`delete from ai_budget_ledger`;
  await sql`delete from feature_flags where key like 'ai.provider.%' or key like 'kill.%'`;
});

const FACTS = {
  asOf: Date.UTC(2026, 9, 12, 8),
  instrumentId: 'BINANCE:PERP:BTCUSDT',
  strategyVersionId: 'sv1',
  dataQuality: 'OK',
  htfBias: { tf: '4h', trend: 'BULL', lastBreak: null },
  levels: [
    { id: 'L7', label: 'Asian low', kind: 'EQL', price: 64020 },
    { id: 'L9', label: 'Sweep low', kind: 'SWING_LOW', price: 63960 },
  ],
  zones: [{ id: 'Z3', label: 'Order block', top: 64110, bottom: 64040, state: 'FRESH' }],
  setups: [
    {
      id: 'S19',
      template: 'T1',
      direction: 'LONG',
      grade: 'A',
      state: 'ARMED',
      reasonCodes: [],
      poi: 'Z3',
      invalidation: 'L9',
      targets: [],
      stats: null,
    },
  ],
  warnings: [],
};
const GOOD = JSON.stringify({
  headline: 'Bullish bias with an armed long idea',
  bias_summary: 'Price swept {{L:L7}} and reacted from {{Z:Z3}}.',
  scenarios: [
    {
      setupId: 'S19',
      kind: 'PRIMARY',
      if_then: 'If price holds {{Z:Z3}}, the idea stays valid.',
      invalidation_ref: 'L9',
      key_refs: ['Z3'],
    },
    {
      setupId: 'S19',
      kind: 'ALTERNATE',
      if_then: 'If price closes below {{L:L9}}, it is invalidated.',
      invalidation_ref: 'L9',
      key_refs: ['L9'],
    },
  ],
  risks_and_unknowns: ['There is not enough history to quote a base rate.'],
  history_line: null,
  refs_used: ['L7', 'Z3', 'L9', 'S19'],
});

type Script = (string | LlmError)[];
function adapter(id: ProviderId, script: Script) {
  const calls: ProviderCallArgs[] = [];
  let i = 0;
  const a: ProviderAdapter & { calls: ProviderCallArgs[] } = {
    id,
    calls,
    async call(args) {
      calls.push(args);
      const s = script[Math.min(i++, script.length - 1)] as string | LlmError;
      if (s instanceof LlmError) throw s;
      return { text: s, usage: { tokensIn: 2000, tokensOut: 400, cachedIn: 0, cacheWrite: 0 } };
    },
  };
  return a;
}

async function boot(
  adapters: (ProviderAdapter & { calls: ProviderCallArgs[] })[],
  env: Record<string, string> = {},
) {
  const { app } = await createTestApp({
    keys,
    env: {
      DATABASE_URL: dbUrl,
      ANTHROPIC_API_KEY: 'test-anthropic',
      OPENAI_API_KEY: 'test-openai',
      OPENAI_MODEL_FAST: 'gpt-test',
      AI_PROVIDER_ANTHROPIC_ENABLED: 'true',
      AI_PRICES_JSON: JSON.stringify({
        'claude-sonnet-5-5': { in: 3, out: 15 },
        'claude-haiku-5-5': { in: 1, out: 5 },
        'gpt-test': { in: 1, out: 5 },
      }),
      ...env,
    },
    overrides: [
      {
        provide: LLM_ROUTER,
        inject: [ProviderConfigService, AiMeterService],
        factory: ((source: ProviderConfigService, meter: AiMeterService) =>
          new LlmRouter({
            source,
            adapters: Object.fromEntries(adapters.map((a) => [a.id, a])),
            prices: PriceTable.parse(
              JSON.stringify({
                'claude-sonnet-5-5': { in: 3, out: 15 },
                'claude-haiku-5-5': { in: 1, out: 5 },
                'gpt-test': { in: 1, out: 5 },
              }),
            ),
            sleep: async () => {},
            onCall: meter.onCall,
            onOutcome: meter.onOutcome,
          })) as never,
      },
    ],
  });
  apps.push(app);
  // The engine is not running in this test; hand the narrative service fixed facts.
  const analysis = app.get(AnalysisService);
  analysis.marketFacts = (async () => ({
    facts: FACTS,
    instrument: { pricePrecision: 2 },
    asOf: FACTS.asOf,
  })) as never;
  return app;
}

const user = async () => `Bearer ${await keys.sign()}`;
const admin = async () =>
  `Bearer ${await keys.sign({ claims: { app_metadata: { role: 'admin' } } })}`;
const instrumentId = async () =>
  (
    await sql<{ id: string }[]>`select id from instruments where canonical = 'BINANCE:PERP:BTCUSDT'`
  )[0]?.id ?? '';

describe('owner provider switches', () => {
  it('lists providers without keys; a database switch overrides the environment default at once', async () => {
    const app = await boot([adapter('anthropic', [GOOD])]);
    const http = app.getHttpServer();
    const list = await request(http)
      .get('/v1/admin/ai/providers')
      .set('Authorization', await admin())
      .set('X-Admin-Confirm', 'yes');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('test-anthropic');
    const by = Object.fromEntries(list.body.items.map((p: { id: string }) => [p.id, p]));
    expect(by.anthropic).toMatchObject({
      enabled: true,
      enabledSource: 'env',
      keyPresent: true,
      ready: true,
    });
    expect(by.openai).toMatchObject({ enabled: false, keyPresent: true });
    expect(by.gemini).toMatchObject({ keyPresent: false, ready: false });

    const off = await request(http)
      .put('/v1/admin/ai/providers/anthropic')
      .set('Authorization', await admin())
      .set('X-Admin-Confirm', 'yes')
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, enabledSource: 'database', ready: false });
    const on = await request(http)
      .put('/v1/admin/ai/providers/openai')
      .set('Authorization', await admin())
      .set('X-Admin-Confirm', 'yes')
      .send({ enabled: true, priority: 1, dataClasses: ['D0'] });
    expect(on.body).toMatchObject({ enabled: true, priority: 1, dataClasses: ['D0'], ready: true });
    const [audit] = await sql`select 1 from audit_log where action = 'admin.ai_provider'`;
    expect(audit).toBeDefined();
  });

  it('rejects a bad provider id, an empty patch and a non-admin', async () => {
    const app = await boot([adapter('anthropic', [GOOD])]);
    const http = app.getHttpServer();
    const a = await admin();
    expect(
      (
        await request(http)
          .put('/v1/admin/ai/providers/nope')
          .set('Authorization', a)
          .set('X-Admin-Confirm', 'yes')
          .send({ enabled: true })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(http)
          .put('/v1/admin/ai/providers/openai')
          .set('Authorization', a)
          .set('X-Admin-Confirm', 'yes')
          .send({})
      ).status,
    ).toBe(422);
    expect(
      (
        await request(http)
          .put('/v1/admin/ai/providers/openai')
          .set('Authorization', await user())
          .send({ enabled: true })
      ).status,
    ).toBe(403);
  });
});

describe('shared narratives', () => {
  it('serves the template at once, then the model text; one call serves every reader; cost is metered', async () => {
    const a = adapter('anthropic', [GOOD]);
    const app = await boot([a]);
    const http = app.getHttpServer();
    const id = await instrumentId();
    const first = await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    expect(first.status).toBe(200);
    const n1 = NarrativeResponseSchema.parse(first.body);
    expect(n1).toMatchObject({ source: 'TEMPLATE', generating: true, aiGenerated: false });

    await app.get(NarrativeService).idle();
    const second = await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    const n2 = NarrativeResponseSchema.parse(second.body);
    expect(n2).toMatchObject({ source: 'LLM', generating: false, aiGenerated: true });
    expect(n2.content.bias_summary).toContain('64,020.00');
    await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    expect(a.calls).toHaveLength(1);

    const [call] = await sql<
      {
        job: string;
        data_class: string;
        cost_usd: string;
        workspace_id: string | null;
        facts_hash: string;
        outcome: string;
        model: string;
      }[]
    >`
      select job, data_class, cost_usd, workspace_id, facts_hash, outcome, model from ai_calls`;
    expect(call).toMatchObject({
      job: 'J2_NARRATIVE',
      data_class: 'D0',
      workspace_id: null,
      outcome: 'OK',
      model: 'claude-sonnet-5-5',
    });
    expect(Number(call?.cost_usd)).toBeCloseTo((2000 * 3 + 400 * 15) / 1e6, 6);
    expect(call?.facts_hash).toBe(n2.factsHash);
    const [g] = await sql<
      { calls: number; cost_usd: string }[]
    >`select calls, cost_usd from ai_global_ledger`;
    expect(g?.calls).toBe(1);

    const spend = await request(http)
      .get('/v1/admin/ai/spend')
      .set('Authorization', await admin())
      .set('X-Admin-Confirm', 'yes');
    expect(spend.body.calls).toBe(1);
    expect(spend.body.narrativeCache.cacheHits).toBeGreaterThanOrEqual(2);
    const costs = await request(http)
      .get('/v1/admin/ai/costs?days=1')
      .set('Authorization', await admin())
      .set('X-Admin-Confirm', 'yes');
    expect(costs.body.items[0]).toMatchObject({
      job: 'J2_NARRATIVE',
      provider: 'anthropic',
      calls: 1,
    });
  });

  it('with the kill switch on, or every provider off, the template is still delivered and no model is called', async () => {
    const a = adapter('anthropic', [GOOD]);
    const app = await boot([a]);
    const http = app.getHttpServer();
    const id = await instrumentId();
    await sql`insert into feature_flags (key, enabled, rollout_pct) values ('kill.AI', true, 100)`;
    await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user()); // prime flag cache
    await new Promise((r) => setTimeout(r, 3100)); // flag cache TTL
    const r1 = await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    expect(r1.body).toMatchObject({ source: 'TEMPLATE', generating: false });
    expect(a.calls).toHaveLength(0);
  });

  it('with no provider enabled the template is delivered', async () => {
    const a = adapter('anthropic', [GOOD]);
    const app = await boot([a], { AI_PROVIDER_ANTHROPIC_ENABLED: 'false' });
    const r = await request(app.getHttpServer())
      .get(`/v1/instruments/${await instrumentId()}/narrative`)
      .set('Authorization', await user());
    expect(r.body).toMatchObject({ source: 'TEMPLATE', generating: false });
    expect(a.calls).toHaveLength(0);
  });

  it('fallback drill: the first provider fails and the next enabled one writes the narrative', async () => {
    const a = adapter('anthropic', [new LlmError('SERVER', 'x', 503)]);
    const o = adapter('openai', [GOOD]);
    const app = await boot([a, o], { AI_PROVIDER_OPENAI_ENABLED: 'true' });
    const http = app.getHttpServer();
    const id = await instrumentId();
    await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    await app.get(NarrativeService).idle();
    const r = await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    expect(r.body.source).toBe('LLM');
    expect(o.calls).toHaveLength(1);
    const rows = await sql<
      { provider: string; outcome: string }[]
    >`select provider, outcome from ai_calls order by created_at`;
    expect(rows.map((x) => `${x.provider}:${x.outcome}`)).toContain('openai:OK');
    expect(rows.some((x) => x.provider === 'anthropic' && x.outcome === 'ERROR')).toBe(true);
  });

  it('a guardrail failure is recorded on the call and the template is used', async () => {
    const bad = JSON.stringify({ ...JSON.parse(GOOD), headline: 'Price is at 64020, buy now' });
    const a = adapter('anthropic', [bad]);
    const app = await boot([a]);
    const http = app.getHttpServer();
    const id = await instrumentId();
    await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    await app.get(NarrativeService).idle();
    const r = await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    expect(r.body.source).toBe('TEMPLATE');
    const rows = await sql<{ outcome: string }[]>`select outcome from ai_calls order by created_at`;
    expect(rows.map((x) => x.outcome)).toEqual(['SCHEMA_RETRY', 'GUARDRAIL_REJECTED']);
  });
});

describe('global spend cap', () => {
  it('trips automatically when reached, is audited, and later generation stops', async () => {
    const a = adapter('anthropic', [GOOD]);
    const app = await boot([a], { AI_GLOBAL_DAILY_CAP_USD: '0.001' });
    const http = app.getHttpServer();
    const id = await instrumentId();
    await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    await app.get(NarrativeService).idle();
    const [g] = await sql<{ tripped_at: Date | null }[]>`select tripped_at from ai_global_ledger`;
    expect(g?.tripped_at).not.toBeNull();
    expect((await sql`select 1 from audit_log where action = 'ai.global_cap_tripped'`).length).toBe(
      1,
    );

    await sql`delete from narratives`;
    const before = a.calls.length;
    const r = await request(http)
      .get(`/v1/instruments/${id}/narrative`)
      .set('Authorization', await user());
    expect(r.body).toMatchObject({ source: 'TEMPLATE', generating: false });
    expect(a.calls.length).toBe(before);
  });
});

describe('unused randomUUID guard', () => {
  it('keeps imports honest', () => {
    expect(typeof randomUUID()).toBe('string');
  });
});
