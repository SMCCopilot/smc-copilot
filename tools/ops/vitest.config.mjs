import { defineConfig } from 'vitest/config';

// Two suites start a throwaway Postgres; run files one at a time so they never compete for the machine.
export default defineConfig({
  test: { testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
