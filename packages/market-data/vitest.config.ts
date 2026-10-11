import { defineConfig } from 'vitest/config';

// Property tests run many cases; turbo runs suites in parallel, so allow for a loaded machine.
export default defineConfig({ test: { testTimeout: 120_000 } });
