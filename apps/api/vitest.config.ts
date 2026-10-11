import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// esbuild (vitest's default transform) does not emit decorator metadata, which Nest's DI needs.
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
          useDefineForClassFields: false,
        },
      },
    }),
  ],
  test: { testTimeout: 30_000, hookTimeout: 180_000, fileParallelism: false },
});
