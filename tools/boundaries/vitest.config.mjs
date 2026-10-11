import { defineConfig } from 'vitest/config';

// The dependency-cruiser tests spawn a real process per case.
export default defineConfig({ test: { testTimeout: 60_000 } });
