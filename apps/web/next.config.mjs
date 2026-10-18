import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Public values only. The repo-root .env.local is the single place the owner keeps config; the web app reads just
// the keys that are safe for a browser (the Supabase URL and anon key) and nothing else.
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

// A hosted production build must not silently point at localhost or an unset Supabase project: fail the build.
// (Local builds are unaffected; set REQUIRE_PUBLIC_WEB_ENV=true to apply the same check anywhere.)
if (
  process.env.NODE_ENV === 'production' &&
  (process.env.RAILWAY_ENVIRONMENT || process.env.REQUIRE_PUBLIC_WEB_ENV === 'true')
) {
  const problems = [];
  if (!/^https:\/\//.test(pick('NEXT_PUBLIC_API_URL')))
    problems.push('NEXT_PUBLIC_API_URL (https)');
  if (!pick('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL')) problems.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!pick('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'))
    problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (problems.length > 0) throw new Error(`web build refused, set: ${problems.join(', ')}`);
}

// Baseline response headers for the web app. No CSP yet: the speech and OCR workers need a tested allow-list (backlog).
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  {
    key: 'Permissions-Policy',
    value: 'microphone=(self), display-capture=(self), camera=(), geolocation=(), payment=()',
  },
];

/** @type {import('next').NextConfig} */
export default {
  // Tests build into their own folder so they can run beside a developer's running server.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  reactStrictMode: true,
  agentRules: false,
  poweredByHeader: false,
  transpilePackages: ['@smc/contracts'],
  env: {
    NEXT_PUBLIC_API_URL:
      pick('NEXT_PUBLIC_API_URL') || `http://localhost:${rootEnv.PORT ?? '3002'}`,
    NEXT_PUBLIC_SUPABASE_URL: pick('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: pick('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'),
  },
};
