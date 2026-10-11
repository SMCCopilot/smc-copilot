import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests boot a real Postgres; initdb on a cold machine takes a while.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
