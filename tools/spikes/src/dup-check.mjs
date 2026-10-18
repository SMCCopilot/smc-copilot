#!/usr/bin/env node
// Restart check: prints row counts and any logical duplicates in the tables a restart could double-write.
//   DATABASE_URL=... node tools/spikes/src/dup-check.mjs
// Read only. Exits non-zero if a duplicate is found.
import { createClient } from '@smc/db';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('set DATABASE_URL');
  process.exit(2);
}
const sql = createClient(url, { max: 1 });
const one = async (q) => Number((await q)[0].n);
const counts = {
  candles: await one(sql`select count(*) n from candles`),
  engine_events: await one(sql`select count(*) n from engine_events`),
  engine_snapshots: await one(sql`select count(*) n from engine_snapshots`),
  setups: await one(sql`select count(*) n from setups`),
  setup_transitions: await one(sql`select count(*) n from setup_transitions`),
};
const dups = {
  candles: await one(
    sql`select count(*) n from (select 1 from candles group by instrument_id, tf, open_time having count(*) > 1) d`,
  ),
  engine_events_same_payload: await one(
    sql`select count(*) n from (select 1 from engine_events group by instrument_id, strategy_version_id, tf, type, anchor_time, payload::text having count(*) > 1) d`,
  ),
  setup_transitions: await one(
    sql`select count(*) n from (select 1 from setup_transitions group by setup_id, from_state, to_state, at_candle having count(*) > 1) d`,
  ),
  setups_same_key: await one(
    sql`select count(*) n from (select 1 from setups group by strategy_version_id, setup_key having count(*) > 1) d`,
  ),
};
await sql.end();
console.log(JSON.stringify({ counts, dups }, null, 1));
process.exit(Object.values(dups).some((n) => n > 0) ? 1 : 0);
