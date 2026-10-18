import { describe, expect, it } from 'vitest';
import { evaluate, render } from '../src/preflight.mjs';

// Placeholders only; none of these is a real credential.
const base = {
  DATABASE_URL: 'postgres://u:p@db.example.test:6543/postgres',
  DATABASE_URL_SESSION: 'postgres://u:p@db.example.test:5432/postgres',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
  WS_TOKEN_SECRET: 'w'.repeat(40),
  ABUSE_HASH_SALT: 's'.repeat(24),
  CORS_ORIGINS: 'https://app.example.test',
  ADMIN_IP_ALLOWLIST: '203.0.113.7',
  METRICS_TOKEN: 'm'.repeat(40),
  SENTRY_DSN: 'https://abc@o1.ingest.sentry.io/1',
  INGEST_ENABLED: 'true',
};
const db = {
  migrations: 11,
  blocklist: 500,
  activeStrategy: true,
  killSwitches: [],
  rlsOff: [],
  venueTerms: 3,
  partitionsAhead: 3,
};
const by = (r, name) => r.find((x) => x.name === name);

describe('preflight', () => {
  it('a complete production setup passes everything', () => {
    const r = evaluate(base, db);
    expect(r.filter((x) => x.level === 'FAIL')).toEqual([]);
    expect(r.filter((x) => x.level === 'WARN').map((x) => x.name)).toEqual(
      ['At least one AI provider is switched on', 'Prices are entered for the active models'].slice(
        0,
        1,
      ),
    );
  });

  it('a production database with exactly the shipped migrations passes; one fewer fails', () => {
    const ok = evaluate(base, { ...db, migrations: 9, migrationsShipped: 9 });
    expect(by(ok, 'Migrations are applied').level).toBe('PASS');
    const short = evaluate(base, { ...db, migrations: 8, migrationsShipped: 9 });
    expect(by(short, 'Migrations are applied').level).toBe('FAIL');
  });

  it('a short metrics token fails', () => {
    const r = evaluate({ ...base, METRICS_TOKEN: 'short' }, db);
    expect(by(r, 'Metrics endpoint is protected and on').level).toBe('FAIL');
  });

  it('missing production secrets fail, naming the variable and never a value', () => {
    const r = evaluate({ ...base, WS_TOKEN_SECRET: undefined, CORS_ORIGINS: '' }, null);
    const f = by(r, 'Configuration is valid for production');
    expect(f.level).toBe('FAIL');
    expect(f.detail).toContain('WS_TOKEN_SECRET');
    expect(JSON.stringify(r)).not.toContain('postgres://u:p');
  });

  it('refuses a production setup with no admin allow-list', () => {
    const r = evaluate({ ...base, ADMIN_IP_ALLOWLIST: '' }, null);
    expect(by(r, 'Admin address allow-list is set').level).toBe('FAIL');
  });

  it('an enabled AI provider needs a key and a model', () => {
    const r = evaluate({ ...base, AI_PROVIDER_OPENAI_ENABLED: 'true' }, null);
    expect(by(r, 'AI provider openai is usable').level).toBe('FAIL');
    const ok = evaluate(
      { ...base, AI_PROVIDER_ANTHROPIC_ENABLED: 'true', ANTHROPIC_API_KEY: 'k'.repeat(20) },
      null,
    );
    expect(by(ok, 'AI provider anthropic is usable').level).toBe('PASS');
    expect(by(ok, 'Prices are entered for the active models').level).toBe('WARN');
  });

  it('database facts: an empty blocklist and missing row-level security fail', () => {
    const r = evaluate(base, {
      ...db,
      blocklist: 0,
      rlsOff: ['t1'],
      killSwitches: ['kill.AI'],
    });
    for (const n of ['Sanctions blocklist is loaded', 'Row-level security is on for every table']) {
      expect(by(r, n).level, n).toBe('FAIL');
    }
    expect(by(r, 'No kill switch is left on').level).toBe('WARN');
  });

  it('renders a plain list and a count', () => {
    const text = render(evaluate(base, db));
    expect(text).toContain('PASS  Configuration is valid for production');
    expect(text).toMatch(/0 failed, \d+ warnings/);
  });
});

describe('database facts against a real, migrated database', () => {
  it('reads every fact without error, and sees an empty blocklist as not ready', async () => {
    const { applyMigrations, createClient } = await import('@smc/db');
    const { startTestServer } = await import('@smc/db/testing');
    const { readDb } = await import('../src/preflight.mjs');
    const server = await startTestServer();
    try {
      const url = await server.createDatabase();
      const sql = createClient(url, { max: 2 });
      await applyMigrations(sql, { withShims: true });
      await sql.end({ timeout: 5 });
      const facts = await readDb(url);
      expect(facts.migrations).toBeGreaterThanOrEqual(11);
      expect(facts.blocklist).toBe(0);
      expect(facts.activeStrategy).toBe(true);
      expect(Array.isArray(facts.rlsOff)).toBe(true);
      const r = evaluate(base, facts);
      expect(by(r, 'Sanctions blocklist is loaded').level).toBe('FAIL');
    } finally {
      await server.stop();
    }
  }, 180_000);
});
