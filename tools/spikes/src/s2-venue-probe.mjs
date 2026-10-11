#!/usr/bin/env node
// Spike S2: can this machine reach the venues, and how late do closed 1m candles arrive?
//   node tools/spikes/src/s2-venue-probe.mjs [--minutes 3] [--dns 1.1.1.1] [--venues binance-spot,binance-perp,bybit-perp]
// Records raw frames to .recordings/s2-<timestamp>/<venue>.jsonl (git-ignored: venue data stays out of the repo)
// and prints a summary table. Run it from the candidate VM region to decide the Oracle home region (A10 S2).
// Public market data only; no keys, no orders. A 24 h recording is `--minutes 1440`.
import { Resolver } from 'node:dns';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch, WebSocket } from 'undici';
import { closedCandles, summarizeLags } from './lag.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const minutes = Number(opt('minutes', '3'));
const dnsServer = opt('dns', undefined);
const wanted = (opt('venues', 'binance-spot,binance-perp,bybit-perp') ?? '').split(',');

/** Optional resolver override: some networks block venue names at the router, which is itself a finding. */
const dispatcher = new Agent({
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

const VENUES = {
  'binance-spot': {
    kind: 'binance',
    rest: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5',
    time: 'https://data-api.binance.vision/api/v3/time',
    ws: ['wss://data-stream.binance.vision/stream?streams=btcusdt@kline_1m'],
  },
  'binance-perp': {
    kind: 'binance',
    rest: 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=5',
    time: 'https://fapi.binance.com/fapi/v1/time',
    // The second URL is the newer split-path layout; whichever connects is reported (decision D-004, [verify]).
    ws: [
      'wss://fstream.binance.com/stream?streams=btcusdt@kline_1m',
      'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1m',
      'wss://fstream.binance.com/ws/btcusdt@kline_1m',
      'wss://fstream.binance.com/public/stream?streams=btcusdt@kline_1m',
    ],
  },
  'bybit-perp': {
    kind: 'bybit',
    rest: 'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&limit=5',
    time: 'https://api.bybit.com/v5/market/time',
    ws: ['wss://stream.bybit.com/v5/public/linear'],
    subscribe: { op: 'subscribe', args: ['kline.1.BTCUSDT'] },
    pingEveryMs: 20_000,
  },
};

// Always under the repository root so the git-ignored .recordings folder is used wherever the script is launched.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = join(
  repoRoot,
  '.recordings',
  `s2-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
mkdirSync(outDir, { recursive: true });

/** Local clock minus venue clock, estimated from one round trip (so lag is not blamed on a skewed machine clock). */
async function clockOffset(venue) {
  try {
    const t0 = Date.now();
    const res = await fetch(venue.time, { dispatcher, signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    const t1 = Date.now();
    const server = body.serverTime ?? body.time ?? Number(body.result?.timeNano) / 1e6;
    return Number.isFinite(server) ? Math.round((t0 + t1) / 2 - server) : null;
  } catch {
    return null;
  }
}

async function probeRest(venue) {
  const started = Date.now();
  try {
    const res = await fetch(venue.rest, { dispatcher, signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    const rows = Array.isArray(body) ? body : body?.result?.list;
    return {
      status: res.status,
      ms: Date.now() - started,
      geoBlocked: res.status === 451 || res.status === 403,
      shapeOk: Array.isArray(rows) && rows.length > 0,
    };
  } catch (error) {
    return {
      status: null,
      ms: Date.now() - started,
      error: String(error?.cause?.code ?? error?.message ?? error),
    };
  }
}

function probeWs(name, venue, url, deadline) {
  return new Promise((resolve) => {
    const record = createWriteStream(join(outDir, `${name}.jsonl`), { flags: 'a' });
    record.on('error', (e) => {
      error = `recording failed: ${e.code ?? e.message}`;
    });
    let done = false;
    const lags = [];
    let frames = 0;
    let connectedAt = null;
    let error = null;
    let ping = null;
    const ws = new WebSocket(url, { dispatcher });
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(ping);
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      record.end(() =>
        resolve({ url, connected: connectedAt !== null, frames, lag: summarizeLags(lags), error }),
      );
    };
    const timer = setTimeout(finish, Math.max(1000, deadline - Date.now()));
    ws.addEventListener('open', () => {
      connectedAt = Date.now();
      if (venue.subscribe) ws.send(JSON.stringify(venue.subscribe));
      if (venue.pingEveryMs)
        ping = setInterval(() => {
          if (!done && ws.readyState === 1) ws.send(JSON.stringify({ op: 'ping' }));
        }, venue.pingEveryMs);
    });
    ws.addEventListener('message', (event) => {
      if (done) return;
      const receivedAt = Date.now();
      const text = String(event.data);
      frames += 1;
      record.write(`${JSON.stringify({ t: receivedAt, raw: text })}\n`);
      for (const { closeTimeMs } of closedCandles(venue.kind, text))
        lags.push(receivedAt - closeTimeMs);
    });
    ws.addEventListener('error', (event) => {
      error = String(
        event?.error?.cause?.code ?? event?.error?.message ?? event?.message ?? 'websocket error',
      );
      if (connectedAt === null) finish();
    });
    ws.addEventListener('close', (event) => {
      if (Date.now() < deadline - 1000 && connectedAt !== null)
        error = error ?? `closed early (${event.code})`;
      finish();
    });
  });
}

const results = {};
for (const name of wanted) {
  const venue = VENUES[name];
  if (!venue) {
    process.stderr.write(`unknown venue ${name}\n`);
    process.exit(2);
  }
  results[name] = { rest: null, ws: null };
}

const deadline = Date.now() + minutes * 60_000;
const ATTEMPT_MS = Math.min(minutes * 60_000, 20_000);
await Promise.all(
  wanted.map(async (name) => {
    const venue = VENUES[name];
    results[name].rest = await probeRest(venue);
    results[name].clockOffsetMs = await clockOffset(venue);
    // Try each candidate URL briefly; the first that delivers frames is then recorded for the full duration.
    let winner = null;
    for (const url of venue.ws) {
      const trial = await probeWs(name, venue, url, Math.min(deadline, Date.now() + ATTEMPT_MS));
      results[name].attempts ??= [];
      results[name].attempts.push({
        url,
        connected: trial.connected,
        frames: trial.frames,
        error: trial.error,
      });
      results[name].ws = trial;
      if (trial.connected && trial.frames > 0) {
        winner = url;
        break;
      }
    }
    if (winner && Date.now() < deadline - 5000) {
      results[name].ws = await probeWs(name, venue, winner, deadline);
    }
  }),
);

const summary = {
  at: new Date().toISOString(),
  minutes,
  dnsOverride: dnsServer ?? null,
  node: process.version,
  results,
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const fmt = (v) => (v === null || v === undefined ? '-' : String(v));
console.log(`\nS2 venue probe (${minutes} min, dns ${dnsServer ?? 'system'}) -> ${outDir}`);
console.log(
  'venue          rest            ws connected  frames  closed  lag p50/p95/max ms        ws url / error',
);
for (const [name, r] of Object.entries(results)) {
  const rest = r.rest.error
    ? `ERR ${r.rest.error}`
    : `${r.rest.status}${r.rest.geoBlocked ? ' GEO-BLOCK' : ''} ${r.rest.ms}ms`;
  const w = r.ws;
  const off = r.clockOffsetMs;
  console.log(
    `${name.padEnd(14)} ${rest.padEnd(15)} ${String(w.connected).padEnd(12)} ${String(w.frames).padEnd(7)} ${String(w.lag.n).padEnd(7)} ${`${fmt(w.lag.p50)}/${fmt(w.lag.p95)}/${fmt(w.lag.max)}`.padEnd(25)} ${fmt(off).padEnd(16)} ${w.error ?? w.url}`,
  );
}
