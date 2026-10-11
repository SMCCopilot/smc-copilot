#!/usr/bin/env node
// Phase 1 exit check: do recorded WebSocket frames, replayed through the production parsers, produce the same
// candles as the venue's own REST history?
//   node tools/spikes/src/s2-venue-probe.mjs --minutes 30 --dns 1.1.1.1     # records frames under .recordings/
//   node tools/spikes/src/verify-frames-vs-rest.mjs [recording-dir] [--dns 1.1.1.1]
// Compares open/high/low/close/volume of every closed 1m candle. Exits non-zero on any difference.
import { Resolver } from 'node:dns';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BinanceProvider,
  BybitProvider,
  normalize,
  parseRecording,
  ReplayProvider,
} from '@smc/market-data';
import { Agent, fetch } from 'undici';

const args = process.argv.slice(2);
const dnsIdx = args.indexOf('--dns');
const dns = dnsIdx >= 0 ? args[dnsIdx + 1] : undefined;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const recordings = join(repoRoot, '.recordings');
const dir =
  args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dns') ??
  join(
    recordings,
    readdirSync(recordings)
      .filter((d) => d.startsWith('s2-'))
      .sort()
      .pop() ?? '',
  );
if (!existsSync(dir)) {
  console.error(`no recording directory found (${dir}); run the S2 probe first`);
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
const fetchImpl = (url, init) => fetch(url, { ...init, dispatcher });

const CASES = [
  {
    file: 'binance-spot.jsonl',
    kind: 'binance',
    marketType: 'SPOT',
    symbol: 'BTCUSDT',
    make: () =>
      new BinanceProvider({
        wsUrl: { SPOT: '', PERP: '' },
        restUrl: { SPOT: 'https://data-api.binance.vision', PERP: 'https://fapi.binance.com' },
        fetchImpl,
      }),
  },
  {
    file: 'binance-perp.jsonl',
    kind: 'binance',
    marketType: 'PERP',
    symbol: 'BTCUSDT',
    make: () =>
      new BinanceProvider({
        wsUrl: { SPOT: '', PERP: '' },
        restUrl: { SPOT: 'https://data-api.binance.vision', PERP: 'https://fapi.binance.com' },
        fetchImpl,
      }),
  },
  {
    file: 'bybit-perp.jsonl',
    kind: 'bybit',
    marketType: 'PERP',
    symbol: 'BTCUSDT',
    make: () => new BybitProvider({ wsUrl: '', restUrl: 'https://api.bybit.com', fetchImpl }),
  },
];

let failed = false;
for (const c of CASES) {
  const path = join(dir, c.file);
  if (!existsSync(path)) continue;
  const frames = parseRecording(readFileSync(path, 'utf8'));
  const replay = new ReplayProvider(frames, { kind: c.kind, marketType: c.marketType });
  const replayed = new Map();
  await replay.subscribe([{ venueSymbol: c.symbol, marketType: c.marketType, tf: '1m' }], {
    onRaw: (raw) => replayed.set(raw.openTimeMs, raw),
    onStatus: () => {},
  });
  await new Promise((r) => setTimeout(r, 500 + frames.length));

  if (replayed.size === 0) {
    console.log(`${c.file}: no closed candles in the recording (record for at least 3 minutes)`);
    failed = true;
    continue;
  }
  const opens = [...replayed.keys()].sort((a, b) => a - b);
  const fromMs = opens[0];
  const toMs = opens[opens.length - 1] + 60_000;
  const rest = new Map();
  for await (const page of c
    .make()
    .fetchCandles({ venueSymbol: c.symbol, marketType: c.marketType, tf: '1m', fromMs, toMs })) {
    for (const r of page) rest.set(r.openTimeMs, r);
  }

  let compared = 0;
  const diffs = [];
  for (const open of opens) {
    const a = normalize(replayed.get(open), 'x', c.kind);
    const bRaw = rest.get(open);
    const b = bRaw ? normalize(bRaw, 'x', c.kind) : null;
    if (!a.ok || !b?.ok) {
      diffs.push(
        `${new Date(open).toISOString()}: ${!a.ok ? 'replayed candle invalid' : 'venue REST has no such candle'}`,
      );
      continue;
    }
    compared += 1;
    for (const f of ['o', 'h', 'l', 'c', 'v']) {
      if (a.candle[f] !== b.candle[f])
        diffs.push(
          `${new Date(open).toISOString()} ${f}: frames ${a.candle[f]} vs REST ${b.candle[f]}`,
        );
    }
  }
  const spanMin = Math.round((toMs - fromMs) / 60_000);
  console.log(
    `${c.file}: ${compared}/${opens.length} candles compared over ${spanMin} min, ${diffs.length} difference(s)`,
  );
  for (const d of diffs.slice(0, 10)) console.log(`  ${d}`);
  if (diffs.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
