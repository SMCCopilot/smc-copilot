#!/usr/bin/env node
// A persistent local Postgres for development: no installed server, no password to share.
//   node tools/dev/src/dev-db.mjs            # starts it, applies the schema (with the auth shims) and stays running
// Data lives in .dev-pg/ at the repository root (git-ignored). Stop with Ctrl+C. Connection URL is printed.
// This is NOT Supabase: it uses the dev shims for auth.users, so it is for local work and tests only.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyMigrations, createClient } from '@smc/db';
import EmbeddedPostgres from 'embedded-postgres';

const dir = fileURLToPath(new URL('../../../.dev-pg', import.meta.url));
const port = Number(process.env.DEV_DB_PORT ?? 54329);
const fresh = !existsSync(`${dir}/PG_VERSION`);

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
  onError: () => {},
});
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('smc_dev');

const url = `postgres://postgres:postgres@127.0.0.1:${port}/smc_dev`;
const sql = createClient(url, { max: 1 });
const result = await applyMigrations(sql, { withShims: true });
await sql.end();
console.log(
  `dev database ready (${result.applied.length} migrations applied, ${result.skipped.length} already present)`,
);
console.log(`DATABASE_URL=${url}`);
console.log('Ctrl+C to stop.');

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
