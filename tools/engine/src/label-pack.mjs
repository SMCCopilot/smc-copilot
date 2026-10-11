#!/usr/bin/env node
// pnpm engine:label-pack: build a blind labeling pack (charts + a self-contained HTML labeling page).
//
//   pnpm engine:label-pack --candles candles.json --out label-pack [--tfs 15m,1h,4h] [--per-tf 7] [--bars 200] [--seed 1]
//   pnpm engine:label-pack --db --instrument BINANCE:SPOT:BTCUSDT --from 2026-08-01 --to 2026-10-01 --out label-pack
//
// Open label-pack/label.html in a browser, label the charts, press Export, then run engine:fidelity.
// The page never shows engine output, so the labels are independent of what the engine finds.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCandleFile, loadCandlesFromDb } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Deterministic 32-bit PRNG so the same inputs always give the same charts. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` non-overlapping windows of `length` bars spread across `total` bars, jittered by the seed. */
export function pickWindows(count, length, total, seed) {
  if (total < length) return [];
  const n = Math.min(count, Math.floor(total / length));
  const rnd = mulberry32(seed);
  const slot = Math.floor(total / n);
  const out = [];
  for (let k = 0; k < n; k++) {
    const slack = Math.max(0, slot - length);
    out.push(k * slot + Math.floor(rnd() * (slack + 1)));
  }
  return out;
}

export function buildPack(candles, { tfs, perTf, bars, seed, packId }) {
  const charts = [];
  for (const tf of tfs) {
    const series = candles.filter((c) => c.tf === tf).sort((a, b) => a.openTime - b.openTime);
    pickWindows(perTf, bars, series.length, seed + tf.length).forEach((start, k) => {
      const slice = series.slice(start, start + bars);
      charts.push({
        id: `${tf}-${String(k + 1).padStart(2, '0')}`,
        instrumentId: slice[0].instrumentId,
        tf,
        candles: slice.map((c) => ({
          instrumentId: c.instrumentId,
          tf: c.tf,
          openTime: c.openTime,
          o: c.o,
          h: c.h,
          l: c.l,
          c: c.c,
          v: c.v,
          closed: true,
          providerId: c.providerId,
        })),
      });
    });
  }
  return { packId, charts };
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tfs = String(args.tfs ?? '15m,1h,4h').split(',');
  let candles;
  if (args.db) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    for (const k of ['instrument', 'from', 'to']) {
      if (typeof args[k] !== 'string') throw new Error(`--${k} is required with --db`);
    }
    candles = (
      await loadCandlesFromDb(process.env.DATABASE_URL, args.instrument, {
        from: args.from,
        to: args.to,
        tfs,
      })
    ).candles;
  } else {
    if (typeof args.candles !== 'string') throw new Error('--candles <file> (or --db) is required');
    candles = loadCandleFile(args.candles);
  }
  const pack = buildPack(candles, {
    tfs,
    perTf: Number(args['per-tf'] ?? 7),
    bars: Number(args.bars ?? 200),
    seed: Number(args.seed ?? 1),
    packId: `pack-${Date.now().toString(36)}`,
  });
  if (pack.charts.length === 0) throw new Error('not enough candles to cut any chart');
  const out = resolve(String(args.out ?? 'label-pack'));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'charts.json'), JSON.stringify(pack));
  const html = readFileSync(join(here, 'label-template.html'), 'utf8').replace(
    '/*PACK_JSON*/null',
    JSON.stringify(pack).replaceAll('<', '\\u003c'),
  );
  writeFileSync(join(out, 'label.html'), html);
  console.log(`${pack.charts.length} charts written to ${out}`);
  console.log(`open ${join(out, 'label.html')} in a browser, label, then press Export`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
