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
    TURNSTILE_SECRET: optionalString,

    BINANCE_WS_URL: z.url().default('wss://data-stream.binance.vision'),
    BINANCE_REST_URL: z.url().default('https://data-api.binance.vision'),
    BINANCE_PERP_WS_URL: z.url().default('wss://fstream.binance.com'),
    BINANCE_PERP_REST_URL: z.url().default('https://fapi.binance.com'),
    BYBIT_WS_URL: z.url().default('wss://stream.bybit.com/v5/public/linear'),
    BYBIT_REST_URL: z.url().default('https://api.bybit.com'),

    ANTHROPIC_API_KEY: optionalString,
    FALLBACK_LLM_PROVIDER: optionalString,
    FALLBACK_LLM_API_KEY: optionalString,
    AI_MODEL_IMAGE_READ: optionalString,
    AI_MODEL_NARRATIVE: optionalString,
    AI_MODEL_CHAT: optionalString,
    AI_MODEL_ROUTER: optionalString,
    AI_MODEL_EXPLAIN: optionalString,
    AI_DAILY_BUDGET_DEFAULT_USD: z.coerce.number().nonnegative().default(0.05),
    AI_GLOBAL_DAILY_CAP_USD: z.coerce.number().nonnegative().default(10),

    SENTRY_DSN: optionalUrl,
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
    ADMIN_IP_ALLOWLIST: csv.pipe(z.array(ipOrCidr)),
    CORS_ORIGINS: csv.pipe(z.array(origin)),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const required = [
      'DATABASE_URL',
      'DATABASE_URL_SESSION',
      'SUPABASE_URL',
      'SUPABASE_JWKS_URL',
      'WS_TOKEN_SECRET',
      'ABUSE_HASH_SALT',
      'TURNSTILE_SECRET',
    ] as const;
    for (const key of required) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
      }
    }
    const minimumLength = [
      ['WS_TOKEN_SECRET', 32],
      ['ABUSE_HASH_SALT', 16],
      ['TURNSTILE_SECRET', 8],
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
  'TURNSTILE_SECRET',
  'ANTHROPIC_API_KEY',
  'FALLBACK_LLM_API_KEY',
  'SENTRY_DSN',
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
