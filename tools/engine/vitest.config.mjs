import { defineConfig } from 'vitest/config';

// The CLI end-to-end tests spawn node and replay the engine; allow for a loaded machine.
export default defineConfig({ test: { testTimeout: 120_000 } });
