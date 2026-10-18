import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

/** An exact origin such as https://app.example (scheme, host, optional port; no path, no wildcard). */
const origin = z.string().refine((v) => {
  try {
    return new URL(v).origin === v;
  } catch {
    return false;
  }
}, 'must be an origin like https://app.example');

const ipOrCidr = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
  .pipe(z.url().optional());

/**
 * Environment contract (B02 section 6). Venue hosts are split per market type because Binance's market-data-only
 * host serves spot only; perpetuals live on a separate host (decision D-004).
 */
const EnvSchema = z
  .object({
    // Fail closed: a deploy that forgets NODE_ENV is treated as production and must supply every secret.
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    APP_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    DATABASE_URL: optionalUrl,
    DATABASE_URL_SESSION: optionalUrl,

    SUPABASE_URL: optionalUrl,
    SUPABASE_JWKS_URL: optionalUrl,
    SUPABASE_JWT_AUD: z.string().min(1).default('authenticated'),

    WS_TOKEN_SECRET: optionalString,
    ABUSE_HASH_SALT: optionalString,
    // The public Supabase anon key (safe to ship to browsers); only the optional dev client needs it.
    SUPABASE_ANON_KEY: optionalString,
    // Version string of the disclaimer text users must accept (A09). Changing it asks everyone to accept again.
    DISCLAIMER_VERSION: z.string().min(1).max(32).default('2026-10-01'),

    BINANCE_WS_URL: z.url().default('wss://data-stream.binance.vision'),
    BINANCE_REST_URL: z.url().default('https://data-api.binance.vision'),
    BINANCE_PERP_WS_URL: z.url().default('wss://fstream.binance.com/market'),
    BINANCE_PERP_REST_URL: z.url().default('https://fapi.binance.com'),
    BYBIT_WS_URL: z.url().default('wss://stream.bybit.com/v5/public/linear'),
    BYBIT_REST_URL: z.url().default('https://api.bybit.com'),

    // AI providers (Phase 5). Each is switched on or off by the owner: the *_ENABLED flag is the starting value,
    // and an admin switch stored in the database (feature_flags) overrides it without a deploy.
    ANTHROPIC_API_KEY: optionalString,
    OPENAI_API_KEY: optionalString,
    GEMINI_API_KEY: optionalString,
    AI_PROVIDER_ANTHROPIC_ENABLED: z.stringbool().default(false),
    AI_PROVIDER_OPENAI_ENABLED: z.stringbool().default(false),
    AI_PROVIDER_GEMINI_ENABLED: z.stringbool().default(false),
    // Order tried among the enabled providers (comma separated); the first that is healthy and allowed answers.
    AI_PROVIDER_ORDER: z.string().default('anthropic,openai,gemini'),
    // Model ids are configuration: a "fast" model (router, reading, short answers) and a "strong" one (narratives, chat, explain).
    ANTHROPIC_MODEL_FAST: z.string().default('claude-haiku-5-5'),
    ANTHROPIC_MODEL_STRONG: z.string().default('claude-sonnet-5-5'),
    OPENAI_MODEL_FAST: optionalString,
    OPENAI_MODEL_STRONG: optionalString,
    GEMINI_MODEL_FAST: optionalString,
    GEMINI_MODEL_STRONG: optionalString,
    // Optional price overrides, USD per million tokens: {"model-id":{"in":1,"out":5,"cachedIn":0.1}}
    AI_PRICES_JSON: optionalString,
    AI_DAILY_BUDGET_DEFAULT_USD: z.coerce.number().nonnegative().default(0.05),
    AI_GLOBAL_DAILY_CAP_USD: z.coerce.number().nonnegative().default(10),
    // Rate limits on AI routes. The per-IP and per-device counters span accounts, so a scripted farm of free accounts
    // behind one address or browser shares one allowance.
    // Account deletion: how long a requested deletion can still be cancelled, and how often the purge looks for due ones (0 = never).
    // How often the retention purge runs (0 = never). The first pass runs a minute after start.
    RETENTION_INTERVAL_MIN: z.coerce.number().int().min(0).default(360),
    ACCOUNT_DELETION_GRACE_HOURS: z.coerce.number().int().min(0).max(720).default(72),
    ACCOUNT_PURGE_INTERVAL_MIN: z.coerce.number().int().min(0).default(60),
    AI_USER_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(10),
    AI_USER_MESSAGES_PER_DAY: z.coerce.number().int().positive().default(200),
    AI_IP_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(150),
    AI_DEVICE_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(150),

    // Live venue ingest (Phase 1). Off by default so tests and database-less development never open sockets.
    INGEST_ENABLED: z.stringbool().default(false),
    // Run the SMC engine over closed candles (worker role, needs INGEST_ENABLED and a database).
    ENGINE_ENABLED: z.stringbool().default(true),
    // Trust the Cloudflare-supplied client address for the admin allow-list. Only true when the API is reachable
    // solely through the tunnel (production); anywhere else the header could be forged.
    TRUST_PROXY_HEADERS: z.stringbool().default(false),
    // Dev only: show raw candles for every instrument regardless of the licence view. Refused in production.
    DEV_RAW_PRICES: z.stringbool().default(false),
    // Dev only: resolve names through these DNS servers when the local network blocks venue hosts.
    DNS_SERVERS: csv.pipe(z.array(z.ipv4())),

    SENTRY_DSN: optionalUrl,
    // Bearer token for GET /metrics (Prometheus). Without it the endpoint does not exist.
    METRICS_TOKEN: optionalString,
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
    ADMIN_IP_ALLOWLIST: csv.pipe(z.array(ipOrCidr)),
    CORS_ORIGINS: csv.pipe(z.array(origin)),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.DEV_RAW_PRICES) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_RAW_PRICES'],
        message: 'must be off in production (raw prices need a venue_terms evidence row)',
      });
    }
    if (env.DNS_SERVERS.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['DNS_SERVERS'],
        message: 'is a development setting and must be empty in production',
      });
    }
    const required = [
      'DATABASE_URL',
      'DATABASE_URL_SESSION',
      'SUPABASE_URL',
      'SUPABASE_JWKS_URL',
      'WS_TOKEN_SECRET',
      'ABUSE_HASH_SALT',
    ] as const;
    for (const key of required) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
      }
    }
    const minimumLength = [
      ['WS_TOKEN_SECRET', 32],
      ['ABUSE_HASH_SALT', 16],
    ] as const;
    for (const [key, min] of minimumLength) {
      const value = env[key];
      if (value !== undefined && value.length < min) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `must be at least ${min} characters`,
        });
      }
    }
    if (env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'required in production' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

const SECRET_KEYS = [
  'DATABASE_URL',
  'DATABASE_URL_SESSION',
  'WS_TOKEN_SECRET',
  'ABUSE_HASH_SALT',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'SENTRY_DSN',
  'METRICS_TOKEN',
] as const satisfies readonly (keyof Env)[];

/** Thrown for invalid configuration. The message lists keys and failure kinds only, never values. */
export class EnvError extends Error {
  constructor(readonly issues: readonly { key: string; problem: string }[]) {
    super(`invalid environment: ${issues.map((i) => `${i.key} (${i.problem})`).join(', ')}`);
    this.name = 'EnvError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  // A blank value ( in a dotenv file) means "not set", so defaults apply uniformly.
  const present = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const result = EnvSchema.safeParse(present);
  if (result.success) return result.data;
  throw new EnvError(
    result.error.issues.map((issue) => ({
      key: String(issue.path[0] ?? '(root)'),
      problem: issue.code === 'custom' ? issue.message : issue.code,
    })),
  );
}

/** Which secrets are set, as booleans. Safe to log at startup. */
export function describeSecrets(env: Env): Record<(typeof SECRET_KEYS)[number], 'set' | 'unset'> {
  return Object.fromEntries(
    SECRET_KEYS.map((k) => [k, env[k] === undefined ? 'unset' : 'set']),
  ) as Record<(typeof SECRET_KEYS)[number], 'set' | 'unset'>;
}
