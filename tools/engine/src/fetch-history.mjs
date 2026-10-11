#!/usr/bin/env node
import { Resolver } from 'node:dns';
// pnpm engine:fetch-history: download venue candle history (public klines, no key) as NDJSON for replay/backtest.
//
//   node tools/engine/src/fetch-history.mjs --symbol BTCUSDT --market SPOT --from 2025-09-01 --to 2026-10-01 \
//        --tfs 5m,15m,1h,4h,1d --out data/history/BINANCE_SPOT_BTCUSDT.ndjson [--dns 1.1.1.1]
//
// Raw exchange data stays out of git (data/ is ignored) and is for internal analysis only (venue terms).
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CandleSchema } from '@smc/contracts';
import { BinanceProvider } from '@smc/market-data';
import { Agent, fetch as undiciFetch } from 'undici';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Some networks block venue names at the router (spike S2); an optional resolver override works around it. */
function dispatcherFor(dnsServer) {
  return new Agent({
    connect: dnsServer
      ? {
          lookup: (hostname, options, callback) => {
            const resolver = new Resolver();
            resolver.setServers([dnsServer]);
            resolver.resolve4(hostname, (err, addresses) => {
              if (err || !addresses?.[0]) return callback(err ?? new Error('no address'));
              if (options?.all)
                return callback(
                  null,
                  addresses.map((address) => ({ address, family: 4 })),
                );
              return callback(null, addresses[0], 4);
            });
          },
        }
      : {},
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ['symbol', 'market', 'from', 'to', 'out']) {
    if (typeof args[k] !== 'string') throw new Error(`--${k} is required`);
  }
  const market = args.market.toUpperCase();
  if (market !== 'SPOT' && market !== 'PERP') throw new Error('--market must be SPOT or PERP');
  const tfs = String(args.tfs ?? '5m,15m,1h,4h,1d').split(',');
  const fromMs = Date.parse(`${args.from}T00:00:00Z`);
  const toMs = Date.parse(`${args.to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs)
    throw new Error('bad --from/--to');

  const dispatcher = dispatcherFor(typeof args.dns === 'string' ? args.dns : undefined);
  const provider = new BinanceProvider({
    wsUrl: { SPOT: 'wss://unused.invalid', PERP: 'wss://unused.invalid' },
    restUrl: { SPOT: 'https://data-api.binance.vision', PERP: 'https://fapi.binance.com' },
    fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher }),
  });
  const canonical = `BINANCE:${market}:${args.symbol.toUpperCase()}`;
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  const out = createWriteStream(args.out);

  for (const tf of tfs) {
    let count = 0;
    let dropped = 0;
    for await (const page of provider.fetchCandles({
      venueSymbol: args.symbol.toUpperCase(),
      marketType: market,
      tf,
      fromMs,
      toMs,
    })) {
      for (const r of page) {
        if (!r.closed) continue;
        const parsed = CandleSchema.safeParse({
          instrumentId: canonical,
          tf,
          openTime: r.openTimeMs,
          o: Number(r.o),
          h: Number(r.h),
          l: Number(r.l),
          c: Number(r.c),
          v: Number(r.v ?? 0),
          closed: true,
          providerId: 'binance',
        });
        if (!parsed.success) {
          dropped++;
          continue;
        }
        out.write(`${JSON.stringify(parsed.data)}\n`);
        count++;
      }
    }
    console.error(
      `${canonical} ${tf}: ${count} candles${dropped ? ` (${dropped} invalid dropped)` : ''}`,
    );
  }
  await new Promise((r) => out.end(r));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
