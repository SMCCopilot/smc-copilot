#!/usr/bin/env node
// pnpm ops:preflight: is this environment fit to open to testers? (B01 section 6, items 7 and 8; B05 week 16, day 1)
//
//   node --env-file=.env.production tools/ops/src/preflight.mjs            checks the configuration only
//   node --env-file=.env.production tools/ops/src/preflight.mjs --db       also reads the database (read-only)
//
// Prints PASS / WARN / FAIL per check and exits 1 if anything FAILs. It never prints a secret value.
import { parseEnv } from '@smc/config';

const LEVEL = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };

/** Pure: configuration (and optionally facts read from the database) in, list of results out. */
export function evaluate(rawEnv, db = null) {
  const out = [];
  const add = (level, name, detail = '') => out.push({ level, name, detail });
  const env = { ...rawEnv, NODE_ENV: 'production' };

  let parsed = null;
  try {
    parsed = parseEnv(env);
    add(LEVEL.PASS, 'Configuration is valid for production');
  } catch (e) {
    add(
      LEVEL.FAIL,
      'Configuration is valid for production',
      (e.issues ?? []).map((i) => `${i.key}: ${i.problem}`).join('; ') || 'invalid',
    );
  }
  if (!parsed) return out;

  parsed.ADMIN_IP_ALLOWLIST.length > 0
    ? add(LEVEL.PASS, 'Admin address allow-list is set')
    : add(
        LEVEL.FAIL,
        'Admin address allow-list is set',
        'ADMIN_IP_ALLOWLIST is empty: every admin call is refused',
      );
  parsed.CORS_ORIGINS.some((o) => /localhost|127\.0\.0\.1/.test(o))
    ? add(LEVEL.WARN, 'CORS allows only real origins', 'a localhost origin is listed')
    : add(LEVEL.PASS, 'CORS allows only real origins');
  parsed.TURNSTILE_DISABLED
    ? add(
        LEVEL.WARN,
        'Bot check (Turnstile) is on',
        'TURNSTILE_DISABLED=true: sign-up relies on the invite code alone',
      )
    : add(LEVEL.PASS, 'Bot check (Turnstile) is on');
  parsed.METRICS_TOKEN && String(parsed.METRICS_TOKEN).length < 32
    ? add(
        LEVEL.FAIL,
        'Metrics endpoint is protected and on',
        'METRICS_TOKEN is shorter than 32 characters',
      )
    : parsed.METRICS_TOKEN
      ? add(LEVEL.PASS, 'Metrics endpoint is protected and on')
      : add(
          LEVEL.WARN,
          'Metrics endpoint is protected and on',
          'METRICS_TOKEN is empty: no alerts can be driven from metrics',
        );
  parsed.SENTRY_DSN
    ? add(LEVEL.PASS, 'Error reporting (Sentry) is set')
    : add(LEVEL.WARN, 'Error reporting (Sentry) is set', 'SENTRY_DSN is empty');
  parsed.TRUST_PROXY_HEADERS
    ? add(
        process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME
          ? LEVEL.FAIL
          : LEVEL.WARN,
        'Proxy header trust is deliberate',
        'TRUST_PROXY_HEADERS=true is only safe when the API is reachable solely through the tunnel',
      )
    : add(LEVEL.PASS, 'Proxy header trust is deliberate');
  parsed.INGEST_ENABLED
    ? add(LEVEL.PASS, 'Live data ingest is on')
    : add(LEVEL.WARN, 'Live data ingest is on', 'INGEST_ENABLED=false: no candles, no analysis');
  parsed.AI_GLOBAL_DAILY_CAP_USD > 0 && parsed.AI_GLOBAL_DAILY_CAP_USD <= 50
    ? add(LEVEL.PASS, 'Global AI cap is set and modest', `$${parsed.AI_GLOBAL_DAILY_CAP_USD} a day`)
    : add(
        LEVEL.WARN,
        'Global AI cap is set and modest',
        `$${parsed.AI_GLOBAL_DAILY_CAP_USD} a day`,
      );

  const providers = [
    [
      'anthropic',
      parsed.AI_PROVIDER_ANTHROPIC_ENABLED,
      parsed.ANTHROPIC_API_KEY,
      parsed.ANTHROPIC_MODEL_FAST ?? parsed.ANTHROPIC_MODEL_STRONG,
    ],
    [
      'openai',
      parsed.AI_PROVIDER_OPENAI_ENABLED,
      parsed.OPENAI_API_KEY,
      parsed.OPENAI_MODEL_FAST ?? parsed.OPENAI_MODEL_STRONG,
    ],
    [
      'gemini',
      parsed.AI_PROVIDER_GEMINI_ENABLED,
      parsed.GEMINI_API_KEY,
      parsed.GEMINI_MODEL_FAST ?? parsed.GEMINI_MODEL_STRONG,
    ],
  ];
  for (const [id, on, key, model] of providers) {
    if (!on) continue;
    !key || !model
      ? add(
          LEVEL.FAIL,
          `AI provider ${id} is usable`,
          !key ? 'enabled but no API key' : 'enabled but no model id',
        )
      : add(LEVEL.PASS, `AI provider ${id} is usable`);
  }
  if (!providers.some(([, on]) => on))
    add(
      LEVEL.WARN,
      'At least one AI provider is switched on',
      'none: all text will be template text (fine for a data-only beta)',
    );
  let priced = {};
  try {
    priced = parsed.AI_PRICES_JSON ? JSON.parse(parsed.AI_PRICES_JSON) : {};
  } catch {
    priced = {};
  }
  const models = providers.filter(([, on]) => on).flatMap(([, , , m]) => (m ? [m] : []));
  models.every((m) => m in priced)
    ? add(LEVEL.PASS, 'Prices are entered for the active models')
    : add(
        LEVEL.WARN,
        'Prices are entered for the active models',
        'missing prices are billed at a high default, so spend limits trip early',
      );

  if (db) {
    db.migrations >= Math.max(11, db.migrationsShipped ?? 0)
      ? add(LEVEL.PASS, 'Migrations are applied', `${db.migrations} applied`)
      : add(LEVEL.FAIL, 'Migrations are applied', `${db.migrations} applied`);
    db.devInvite
      ? add(LEVEL.FAIL, 'The development invite code does not exist', 'DEV-BETA-0001 is present')
      : add(LEVEL.PASS, 'The development invite code does not exist');
    db.invites > 0
      ? add(LEVEL.PASS, 'Real invite codes exist', `${db.invites}`)
      : add(
          LEVEL.FAIL,
          'Real invite codes exist',
          'none: nobody can sign up (mint with POST /v1/admin/invites)',
        );
    db.blocklist > 0
      ? add(LEVEL.PASS, 'Sanctions blocklist is loaded', `${db.blocklist} entries`)
      : add(LEVEL.FAIL, 'Sanctions blocklist is loaded', 'empty (POST /v1/admin/blocklist/import)');
    db.activeStrategy
      ? add(LEVEL.PASS, 'An active strategy version exists')
      : add(LEVEL.FAIL, 'An active strategy version exists');
    db.signupOpen
      ? add(
          LEVEL.FAIL,
          'Open sign-up is off',
          'flag signup.open is on: invite codes are not required',
        )
      : add(LEVEL.PASS, 'Open sign-up is off');
    db.killSwitches.length > 0
      ? add(LEVEL.WARN, 'No kill switch is left on', db.killSwitches.join(', '))
      : add(LEVEL.PASS, 'No kill switch is left on');
    db.rlsOff.length === 0
      ? add(LEVEL.PASS, 'Row-level security is on for every table')
      : add(
          LEVEL.FAIL,
          'Row-level security is on for every table',
          db.rlsOff.slice(0, 5).join(', '),
        );
    db.venueTerms > 0
      ? add(LEVEL.PASS, 'Venue terms are recorded', `${db.venueTerms}`)
      : add(
          LEVEL.WARN,
          'Venue terms are recorded',
          'no venue_terms rows (licence stays INTERNAL_ONLY, which is the safe default)',
        );
    db.partitionsAhead >= 2
      ? add(LEVEL.PASS, 'Candle partitions exist ahead', `${db.partitionsAhead}`)
      : add(LEVEL.WARN, 'Candle partitions exist ahead', `${db.partitionsAhead}`);
  }
  return out;
}

export async function readDb(url) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const one = async (q) => (await sql.unsafe(q))[0];
    const migrations = Number(
      (await one('select count(*)::int as n from smc_meta.migrations').catch(() => ({ n: 0 }))).n,
    );
    const { readdirSync } = await import('node:fs');
    const shipped = (() => {
      try {
        return readdirSync(new URL('../../../packages/db/migrations/', import.meta.url)).filter(
          (f) => /^d{4}_.*.sql$/.test(f) && !f.includes('dev_shims'),
        ).length;
      } catch {
        return undefined;
      }
    })();
    const devInvite =
      Number(
        (await one("select count(*)::int as n from invite_codes where code = 'DEV-BETA-0001'")).n,
      ) > 0;
    const invites = Number(
      (
        await one(
          'select count(*)::int as n from invite_codes where uses < max_uses and (expires_at is null or expires_at > now())',
        )
      ).n,
    );
    const blocklist = Number((await one('select count(*)::int as n from address_blocklist')).n);
    const activeStrategy =
      Number(
        (await one("select count(*)::int as n from strategy_versions where status = 'ACTIVE'")).n,
      ) > 0;
    const flags = await sql.unsafe(
      "select key, enabled from feature_flags where enabled and (key = 'signup.open' or key like 'kill.%')",
    );
    const rls = await sql.unsafe(
      "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity and c.relispartition = false",
    );
    const venueTerms = Number((await one('select count(*)::int as n from venue_terms')).n);
    const partitionsAhead = Number(
      (
        await one(
          "select count(*)::int as n from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'candles'::regclass and c.relname > 'candles_' || to_char(date_trunc('month', now() + interval '1 month'), 'YYYY_MM')",
        )
      ).n,
    );
    return {
      migrations,
      migrationsShipped: shipped,
      devInvite,
      invites,
      blocklist,
      activeStrategy,
      signupOpen: flags.some((f) => f.key === 'signup.open'),
      killSwitches: flags.filter((f) => f.key.startsWith('kill.')).map((f) => f.key),
      rlsOff: rls.map((r) => r.relname),
      venueTerms,
      partitionsAhead,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function render(results) {
  const mark = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };
  return `${results.map((r) => `${mark[r.level]}  ${r.name}${r.detail ? ` - ${r.detail}` : ''}`).join('\n')}\n\n${results.filter((r) => r.level === 'FAIL').length} failed, ${results.filter((r) => r.level === 'WARN').length} warnings\n`;
}

if (process.argv[1]?.endsWith('preflight.mjs')) {
  (async () => {
    const withDb = process.argv.includes('--db');
    const db = withDb
      ? await readDb(process.env.DATABASE_URL_SESSION || process.env.DATABASE_URL)
      : null;
    const results = evaluate(process.env, db);
    process.stdout.write(render(results));
    if (results.some((r) => r.level === 'FAIL')) process.exitCode = 1;
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  });
}
