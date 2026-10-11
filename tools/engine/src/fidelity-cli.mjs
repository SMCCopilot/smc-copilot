#!/usr/bin/env node
// pnpm engine:fidelity --pack label-pack/charts.json --labels labels.json [--config cfg.json] [--report docs/engine-fidelity.md]
// Exit code 1 when any gate family with data misses its target (so "adjust" is visible in CI or scripts).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, renderReport } from './fidelity.mjs';
import { loadConfig } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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

try {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.pack !== 'string' || typeof args.labels !== 'string') {
    throw new Error('--pack <charts.json> and --labels <labels.json> are required');
  }
  const pack = JSON.parse(readFileSync(args.pack, 'utf8'));
  const labelFile = JSON.parse(readFileSync(args.labels, 'utf8'));
  if (labelFile.packId !== pack.packId) {
    throw new Error(`labels were made for pack ${labelFile.packId}, not ${pack.packId}`);
  }
  const cfg = loadConfig(args.config ?? join(here, '../configs/smc-core-v1.json'), 'fidelity');
  const result = evaluate(labelFile.labels, pack.charts, cfg);
  const report = renderReport(result, {
    packId: pack.packId,
    labelCount: labelFile.labels.length,
    chartCount: pack.charts.length,
    configId: typeof args.config === 'string' ? args.config : 'smc-core v1',
  });
  if (typeof args.report === 'string') writeFileSync(args.report, report);
  console.log(report);
  const failed = Object.values(result.gate).some((g) => g.agreement !== null && !g.pass);
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
