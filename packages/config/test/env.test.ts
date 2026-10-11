import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeSecrets, EnvError, loadDotEnv, parseEnv } from '../src/index.js';

// Obviously fake values; the real ones live in .env.local, which is git-ignored.
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db.example:6543/postgres', // gitleaks:allow
  DATABASE_URL_SESSION: 'postgresql://u:p@db.example:5432/postgres', // gitleaks:allow
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_JWKS_URL: 'https://abc.supabase.co/auth/v1/.well-known/jwks.json',
  WS_TOKEN_SECRET: 'x'.repeat(32),
  ABUSE_HASH_SALT: 'y'.repeat(16),
  TURNSTILE_SECRET: 'z'.repeat(8),
  CORS_ORIGINS: 'https://app.example',
};
const dev = { NODE_ENV: 'development' };

describe('.env.example', () => {
  it('loads as a valid development configuration with every secret unset', () => {
    const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const parsed: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) parsed[m[1] as string] = m[2] as string;
    }
    const env = parseEnv(parsed);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(parsed)).toContain('BINANCE_PERP_WS_URL');
  });
});

describe('parseEnv', () => {
  it('boots in development with nothing else set (health endpoints must work without a database)', () => {
    const env = parseEnv(dev);
    expect(env.APP_ROLE).toBe('all');
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('fails closed: a forgotten NODE_ENV is production and demands production settings', () => {
    expect(() => parseEnv({})).toThrow(EnvError);
  });

  it('defaults to the spot and perp venue hosts separately', () => {
    const env = parseEnv(dev);
    expect(env.BINANCE_WS_URL).toContain('data-stream.binance.vision');
    expect(env.BINANCE_PERP_WS_URL).toContain('fstream.binance.com');
  });

  it('treats blank values as unset everywhere, so defaults apply (a blank cost cap is not zero)', () => {
    const env = parseEnv({
      ...dev,
      ANTHROPIC_API_KEY: '',
      DATABASE_URL: '  ',
      PORT: '',
      AI_GLOBAL_DAILY_CAP_USD: '',
      SUPABASE_JWT_AUD: '',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PORT).toBe(3000);
    expect(env.AI_GLOBAL_DAILY_CAP_USD).toBe(10);
    expect(env.SUPABASE_JWT_AUD).toBe('authenticated');
  });

  it('parses comma separated lists', () => {
    const env = parseEnv({
      ...dev,
      CORS_ORIGINS: 'https://a.example, https://b.example,',
      ADMIN_IP_ALLOWLIST: '203.0.113.7,2001:db8::1,10.0.0.0/8',
    });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(env.ADMIN_IP_ALLOWLIST).toHaveLength(3);
  });

  it.each(['*', 'https://a.example/path', 'app.example', 'https://a.example/'])(
    'rejects CORS origin %s (exact origins only, no wildcard)',
    (bad) => {
      expect(() => parseEnv({ ...prod, CORS_ORIGINS: bad })).toThrow(/CORS_ORIGINS/);
    },
  );

  it('rejects an admin allow-list entry that is not an IP or CIDR', () => {
    expect(() => parseEnv({ ...dev, ADMIN_IP_ALLOWLIST: 'not-an-ip' })).toThrow(
      /ADMIN_IP_ALLOWLIST/,
    );
  });

  it('accepts a complete production configuration', () => {
    expect(parseEnv(prod).NODE_ENV).toBe('production');
  });

  it('does not apply production requirements in test or development', () => {
    expect(parseEnv({ NODE_ENV: 'test' }).NODE_ENV).toBe('test');
  });

  it.each([
    'DATABASE_URL',
    'DATABASE_URL_SESSION',
    'SUPABASE_URL',
    'SUPABASE_JWKS_URL',
    'WS_TOKEN_SECRET',
    'ABUSE_HASH_SALT',
    'TURNSTILE_SECRET',
    'CORS_ORIGINS',
  ])('rejects production without %s', (key) => {
    const { [key as keyof typeof prod]: _removed, ...rest } = prod;
    expect(() => parseEnv(rest)).toThrow(new RegExp(key));
  });

  it.each([
    ['WS_TOKEN_SECRET', 'short'],
    ['ABUSE_HASH_SALT', 'a'],
    ['TURNSTILE_SECRET', 'b'],
  ])('rejects a too-short %s in production', (key, value) => {
    expect(() => parseEnv({ ...prod, [key]: value })).toThrow(new RegExp(key));
  });

  it('never puts a value into the error message', () => {
    const secret = 'postgresql-super-secret-value';
    try {
      parseEnv({ ...dev, DATABASE_URL: secret, PORT: 'not-a-port' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as Error).message).not.toContain(secret);
      expect((e as Error).message).not.toContain('not-a-port');
      expect((e as Error).message).toMatch(/DATABASE_URL/);
      expect((e as Error).message).toMatch(/PORT/);
    }
  });

  it('describes secrets as set/unset without exposing them', () => {
    const summary = describeSecrets(parseEnv({ ...dev, ANTHROPIC_API_KEY: 'sk-live-abc' }));
    expect(summary.ANTHROPIC_API_KEY).toBe('set');
    expect(summary.DATABASE_URL).toBe('unset');
    expect(JSON.stringify(summary)).not.toContain('sk-live-abc');
  });
});

describe('loadDotEnv', () => {
  const dirs: string[] = [];
  const touched = ['SMC_T_FROM_LOCAL', 'SMC_T_FROM_ENV', 'SMC_T_HOST_WINS'];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const k of touched) delete process.env[k];
  });

  it('loads .env.local before .env, and never overrides variables the host already set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smc-dotenv-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env.local'), 'SMC_T_FROM_LOCAL=local\nSMC_T_HOST_WINS=local\n');
    writeFileSync(
      join(dir, '.env'),
      'SMC_T_FROM_ENV=env\nSMC_T_FROM_LOCAL=env\nSMC_T_HOST_WINS=env\n',
    );
    process.env.SMC_T_HOST_WINS = 'host';

    expect(loadDotEnv(dir)).toEqual(['.env.local', '.env']);
    expect(process.env.SMC_T_FROM_LOCAL).toBe('local');
    expect(process.env.SMC_T_FROM_ENV).toBe('env');
    expect(process.env.SMC_T_HOST_WINS).toBe('host');
  });

  it('returns nothing when neither file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smc-dotenv-'));
    dirs.push(dir);
    expect(loadDotEnv(dir)).toEqual([]);
  });
});
