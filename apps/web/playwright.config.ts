import { defineConfig } from '@playwright/test';

// The browser tests run the real web app against a fake API and a fake Supabase session (both intercepted in the
// browser), so no wallet, database or network is needed. A real wallet sign-in is a manual test.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/copy-vendor.mjs && pnpm exec next dev -p 3100',
    url: 'http://localhost:3100',
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: '.next-e2e',
      NEXT_PUBLIC_API_URL: 'http://api.test',
      NEXT_PUBLIC_SUPABASE_URL: 'http://supabase.test',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
    },
  },
});
