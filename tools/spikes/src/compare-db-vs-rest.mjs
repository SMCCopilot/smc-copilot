#!/usr/bin/env node
// Live-data check: do the candles the running ingest stored match the venues' own REST history?
//   DATABASE_URL=... node tools/spikes/src/compare-db-vs-rest.mjs [--dns 1.1.1.1] [--tf 1m,5m,1h] [--limit 60]
// Reads the database only (never writes). Compares open, high, low, close and volume of every closed candle the
// database has in the last `limit` candles per instrument and timeframe. Exits non-zero on any difference.
import { Resolver } from 'node:dns';
import { createClient } from '@smc/db';
import { Agent, fetch } from 'undici';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const dns = opt('--dns');
const tfs = opt('--tf', '1m,5m,1h').split(',');
const limit = Number(opt('--limit', '60'));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('set DATABASE_URL');
  process.exit(2);
}

const dispatcher = new Agent({
  connect: dns
    ? {
        lookup: (host, options, cb) => {
          const r = new Resolver();
          r.setServers([dns]);
          r.resolve4(host, (err, addrs) => {
            if (err || !addrs?.[0]) return cb(err ?? new Error('no address'));
            return options?.all
              ? cb(
                  null,
                  addrs.map((address) => ({ address, family: 4 })),
                )
              : cb(null, addrs[0], 4);
          });
        },
      }
    : {},
});
const getJson = async (u) => {
  const res = await fetch(u, { dispatcher });
  if (!res.ok) throw new Error(`${u} -> ${res.status}`);
  return res.json();
};

const MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
const BN = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
const BB = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

/** Venue candles as Map(openTimeMs -> [o,h,l,c,v]). */
async function rest(venue, market, symbol, tf, fromMs, toMs) {
  const out = new Map();
  if (venue === 'BINANCE') {
    const base =
      market === 'PERP'
        ? 'https://fapi.binance.com/fapi/v1'
        : 'https://data-api.binance.vision/api/v3';
    const rows = await getJson(
      `${base}/klines?symbol=${symbol}&interval=${BN[tf]}&startTime=${fromMs}&endTime=${toMs}&limit=1000`,
    );
    for (const k of rows) out.set(Number(k[0]), [k[1], k[2], k[3], k[4], k[5]].map(Number));
  } else if (venue === 'BYBIT') {
    const rows = (
      await getJson(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${BB[tf]}&start=${fromMs}&end=${toMs}&limit=1000`,
      )
    ).result.list;
    for (const k of rows) out.set(Number(k[0]), [k[1], k[2], k[3], k[4], k[5]].map(Number));
  }
  return out;
}

const sql = createClient(url, { max: 1 });
const instruments = await sql`
  select id, canonical, venue_id, market_type, base, quote from instruments where active order by canonical`;
let compared = 0;
let diffs = 0;
let missing = 0;
const lines = [];
for (const inst of instruments) {
  for (const tf of tfs) {
    const rows = await sql`
      select extract(epoch from open_time) * 1000 as t, o, h, l, c, v from candles
       where instrument_id = ${inst.id} and tf = ${tf} and status = 'CLOSED'
       order by open_time desc limit ${limit}`;
    if (rows.length === 0) {
      lines.push(`${inst.canonical} ${tf}: no closed candles stored`);
      continue;
    }
    const from = Number(rows[rows.length - 1].t);
    const to = Number(rows[0].t) + MS[tf];
    let ref;
    try {
      ref = await rest(inst.venue_id, inst.market_type, inst.base + inst.quote, tf, from, to);
    } catch (e) {
      lines.push(`${inst.canonical} ${tf}: REST failed (${e.message})`);
      continue;
    }
    let bad = 0;
    let miss = 0;
    for (const r of rows) {
      const v = ref.get(Number(r.t));
      if (!v) {
        miss++;
        continue;
      }
      compared++;
      const mine = [r.o, r.h, r.l, r.c, r.v].map(Number);
      // Volume is compared with a small relative tolerance (venues round differently); prices must be exact.
      const same =
        mine.slice(0, 4).every((x, i) => x === v[i]) ||
        mine.slice(0, 4).every((x, i) => Math.abs(x - v[i]) <= Math.abs(v[i]) * 1e-9);
      const volOk = Math.abs(mine[4] - v[4]) <= Math.max(1e-9, Math.abs(v[4]) * 1e-6);
      if (!same || !volOk) {
        bad++;
        if (bad <= 2)
          lines.push(
            `  DIFF ${inst.canonical} ${tf} ${new Date(Number(r.t)).toISOString()} db=${mine} rest=${v}`,
          );
      }
    }
    diffs += bad;
    missing += miss;
    lines.push(
      `${inst.canonical} ${tf}: ${rows.length} stored, ${bad} differ, ${miss} not in REST window`,
    );
  }
}
await sql.end();
console.log(lines.join('\n'));
console.log(`\ncompared ${compared} candles, ${diffs} differ, ${missing} not found in REST`);
process.exit(diffs > 0 ? 1 : 0);
