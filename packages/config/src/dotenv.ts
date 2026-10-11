import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env.local` then `.env` from `dir` into `process.env` without overriding variables that are already set,
 * so the host's real environment always wins. Secrets are never read from anywhere else and never printed.
 */
export function loadDotEnv(dir: string = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const name of ['.env.local', '.env']) {
    const file = resolve(dir, name);
    if (existsSync(file)) {
      process.loadEnvFile(file);
      loaded.push(name);
    }
  }
  return loaded;
}
