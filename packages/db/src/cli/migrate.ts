import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { applyMigrations } from '../migrations.js';

// Usage: node dist/cli/migrate.js [--shims] [--upgrade] [--forex]
// Connects with DATABASE_URL_SESSION (session pooler / direct), falling back to DATABASE_URL.
// Credentials come from the environment or .env.local; they are never printed.

for (const file of [resolve('.env.local'), resolve('../../.env.local')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const args = new Set(process.argv.slice(2));
const url = process.env.DATABASE_URL_SESSION || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_SESSION or DATABASE_URL must be set (see .env.example)');
  process.exit(2);
}

const host = new URL(url).hostname;
const isSupabase = /supabase\.(co|com)$/.test(host);
if (args.has('--shims') && isSupabase) {
  console.error('refusing --shims against Supabase: it already provides auth.users and auth.uid()');
  process.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const result = await applyMigrations(sql, {
    withShims: args.has('--shims'),
    withUpgrade: args.has('--upgrade'),
    withForex: args.has('--forex'),
  });
  for (const name of result.applied) console.log(`applied  ${name}`);
  for (const name of result.skipped) console.log(`skipped  ${name}`);
  console.log(`done: ${result.applied.length} applied, ${result.skipped.length} already present`);
} finally {
  await sql.end();
}
