import { defineConfig } from 'vitest/config';

// Bootstrap tests resample thousands of times; allow for a loaded machine.
export default defineConfig({ test: { testTimeout: 120_000 } });
