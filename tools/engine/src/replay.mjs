#!/usr/bin/env node
// pnpm engine:replay: run the pure engine over candles and print a deterministic summary.
//
//   pnpm engine:replay --candles candles.json [--config cfg.json] [--version-id v] [--events out.ndjson]
//                      [--expect-hash <sha1>] [--facts]
//   pnpm engine:replay --db --instrument BINANCE:SPOT:BTCUSDT --from 2026-09-01 --to 2026-10-01
//                      [--tfs 5m,15m,1h,4h,1d] [--export-candles out.json] [...]   (needs DATABASE_URL)
//
// Build first (`pnpm build`): the tool imports the compiled engine. Exit code 1 when --expect-hash differs.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEFRAME_MS } from '@smc/contracts';
import { buildFacts } from '@smc/smc-engine';
import { loadCandleFile, loadCandlesFromDb, loadConfig, replay } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(
    args.config ?? join(here, '../configs/smc-core-v1.json'),
    args['version-id'] ?? 'replay',
  );

  let candles;
  if (args.db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    for (const k of ['instrument', 'from', 'to']) {
      if (typeof args[k] !== 'string') throw new Error(`--${k} is required with --db`);
    }
    const tfs = String(args.tfs ?? cfg.timeframes.analysis.join(',')).split(',');
    const r = await loadCandlesFromDb(url, args.instrument, { from: args.from, to: args.to, tfs });
    candles = r.candles;
    if (r.skipped > 0) console.error(`skipped ${r.skipped} INCOMPLETE candles`);
  } else {
    if (typeof args.candles !== 'string') throw new Error('--candles <file> (or --db) is required');
    candles = loadCandleFile(args.candles);
  }
  if (typeof args['export-candles'] === 'string') {
    writeFileSync(args['export-candles'], JSON.stringify(candles));
  }

  const r = replay(candles, cfg);
  if (typeof args.events === 'string') {
    writeFileSync(args.events, `${r.events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }
  const summary = {
    instrument: candles[0].instrumentId,
    strategyVersionId: cfg.strategyVersionId,
    candles: candles.length,
    events: r.events.length,
    counts: r.counts,
    streamHash: r.hash,
    stateHash: r.stateHash,
  };
  if (args.facts) {
    // asOf is a CLOSE time: the close of the newest candle processed on any timeframe.
    const asOf = Math.max(
      ...Object.entries(r.state.lastCandleOpenTime).map(([tf, open]) => open + TIMEFRAME_MS[tf]),
    );
    summary.facts = buildFacts(r.state, cfg, { asOf, dataQuality: 'OK' });
  }
  console.log(JSON.stringify(summary, null, 2));
  if (typeof args['expect-hash'] === 'string' && args['expect-hash'] !== r.hash) {
    console.error(`stream hash mismatch: expected ${args['expect-hash']}, got ${r.hash}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
