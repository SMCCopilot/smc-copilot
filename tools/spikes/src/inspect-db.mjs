#!/usr/bin/env node
// Read-only look at a database before anything is changed: which schemas and tables exist and how many users and
// records it holds. Prints counts only, never values.
//   DATABASE_URL=... node tools/spikes/src/inspect-db.mjs
import { createClient } from '@smc/db';

const url = process.env.DATABASE_URL_SESSION || process.env.DATABASE_URL;
if (!url) {
  console.error('set DATABASE_URL_SESSION or DATABASE_URL');
  process.exit(2);
}
const sql = createClient(url, { max: 1 });
const n = async (q) => Number((await q)[0].n);
const exists = async (t) => (await sql`select to_regclass(${t}) as r`)[0].r !== null;
const out = {};
out.publicTables = await n(sql`select count(*) n from pg_tables where schemaname = 'public'`);
out.migrationsApplied = (await exists('smc_meta.migrations'))
  ? await n(sql`select count(*) n from smc_meta.migrations`)
  : null;
out.authUsers = (await exists('auth.users'))
  ? await n(sql`select count(*) n from auth.users`)
  : null;
for (const t of [
  'profiles',
  'wallets',
  'workspaces',
  'sessions',
  'trades',
  'journal_entries',
  'setups',
  'candles',
  'invite_codes',
  'ai_calls',
]) {
  out[t] = (await exists(`public.${t}`))
    ? await n(sql.unsafe(`select count(*) n from public.${t}`))
    : 'no table';
}
console.log(JSON.stringify(out, null, 1));
await sql.end();
