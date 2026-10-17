import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Public values only. The repo-root .env.local is the single place the owner keeps config; the web app reads just
// the keys that are safe for a browser (the Supabase URL and anon key, the Turnstile SITE key) and nothing else.
const rootEnv = existsSync('../../.env.local')
  ? parseEnv(readFileSync('../../.env.local', 'utf8'))
  : {};
const pick = (...keys) => {
  for (const k of keys) {
    const v = process.env[k] ?? rootEnv[k];
    if (v) return v;
  }
  return '';
};

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  agentRules: false,
  poweredByHeader: false,
  transpilePackages: ['@smc/contracts'],
  env: {
    NEXT_PUBLIC_API_URL:
      pick('NEXT_PUBLIC_API_URL') || `http://localhost:${rootEnv.PORT ?? '3002'}`,
    NEXT_PUBLIC_SUPABASE_URL: pick('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: pick('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: pick('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'TURNSTILE_SITE_KEY'),
  },
};
