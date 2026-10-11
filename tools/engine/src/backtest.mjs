#!/usr/bin/env node
// pnpm engine:backtest: replay history through the engine and evaluate the shadow outcomes against criteria that
// were pre-registered in docs/backtest-criteria.md.
//
//   node tools/engine/src/backtest.mjs --candles data/history/a.ndjson --candles data/history/b.ndjson \
//        --from 2025-10-01 --to 2026-10-01 [--config cfg.json] [--trials 2] [--seed 1] \
//        [--report docs/backtest-report.md] [--json out.json] [--db]       (--db needs DATABASE_URL)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '@smc/analytics';
import { createEngine, feed } from '@smc/smc-engine';
import { collectFromEvents, DEFAULT_TICKS, mergeFunnels, renderReport } from './backtest-lib.mjs';
import { loadCandleFile, loadConfig } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { candles: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : next;
    if (value !== true) i++;
    if (key === 'candles') out.candles.push(value);
    else out[key] = value;
  }
  return out;
}

/** The pre-registered criteria (docs/backtest-criteria.md). Changing them here without changing that file is a bug. */
export const CRITERIA = { minTrades: 30, lowerBoundAbove: 0, minPositiveWindows: 2, windows: 3 };
export const LIMITS = [
  'One year in one market regime, crypto majors only. The four series are strongly correlated, so the effective sample is smaller than the trade count.',
  'Higher-timeframe bias is often unknown (few 4h and 1d candles in a year); bias-dependent scoring then falls back to the neutral value.',
  'The fill model cannot see order books or queue position; real fills in fast markets would be worse.',
  'In-sample risk: the designer is not blind to crypto history. A pass would justify a live shadow period, not trust.',
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.candles.length === 0)
    throw new Error('--candles <file> is required (repeat for more series)');
  for (const k of ['from', 'to'])
    if (typeof args[k] !== 'string') throw new Error(`--${k} is required`);
  const range = {
    from: Date.parse(`${args.from}T00:00:00Z`),
    to: Date.parse(`${args.to}T00:00:00Z`),
  };
  const cfg = loadConfig(args.config ?? join(here, '../configs/smc-core-v1.json'), 'backtest');

  const series = [];
  const allTrades = [];
  const allOutcomes = [];
  const funnels = [];
  let dataFrom = Number.POSITIVE_INFINITY;
  for (const file of args.candles) {
    const candles = loadCandleFile(file);
    const id = candles[0].instrumentId;
    const counts = {};
    for (const c of candles) {
      counts[c.tf] = (counts[c.tf] ?? 0) + 1;
      dataFrom = Math.min(dataFrom, c.openTime);
    }
    const started = Date.now();
    const tickSize = DEFAULT_TICKS[id];
    if (!(tickSize > 0)) {
      throw new Error(
        `no tick size known for ${id}; zero would remove slippage and flatter the result`,
      );
    }
    const { events } = feed(createEngine(id), candles, cfg, { tickSize });
    const got = collectFromEvents(events, range);
    allTrades.push(...got.trades);
    allOutcomes.push(...got.outcomes);
    funnels.push(got.funnel);
    series.push({ id, counts });
    console.error(
      `${id}: ${candles.length} candles, ${events.length} events, ${got.trades.length} trades (${Date.now() - started} ms)`,
    );
  }

  const trials = args.trials === undefined ? 2 : Number(args.trials);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error('--trials must be a whole number of at least 1');
  }
  if (trials !== 2)
    console.error(`note: the pre-registered run counts 2 trials; this run counts ${trials}`);
  const seed = args.seed === undefined ? 1 : Number(args.seed);
  if (!Number.isFinite(seed)) throw new Error('--seed must be a number');
  // Split at exact calendar dates (the pre-registered ones), else at 50/25/25 of the span.
  let boundaries;
  if (typeof args['split-at'] === 'string') {
    boundaries = args['split-at'].split(',').map((d) => Date.parse(`${d}T00:00:00Z`));
    if (boundaries.length !== 2 || boundaries.some((b) => !Number.isFinite(b))) {
      throw new Error('--split-at needs two dates, e.g. 2026-04-01,2026-07-01');
    }
  }
  const results = runBacktest(allTrades, range, CRITERIA, {
    trialsCount: trials,
    seed,
    ...(boundaries ? { boundaries } : {}),
  });
  const funnel = mergeFunnels(funnels);
  const report = renderReport({
    results,
    funnel,
    series,
    meta: {
      strategy: 'smc-core v1 (unmodified)',
      criteriaCommit: String(
        args['criteria-commit'] ?? 'see git history of docs/backtest-criteria.md',
      ),
      generatedAt: new Date().toISOString().slice(0, 10),
      range,
      dataFrom,
      outcomes: allOutcomes,
      trades: allTrades,
      limits: LIMITS,
    },
  });
  if (typeof args.report === 'string') writeFileSync(args.report, report);
  if (typeof args.json === 'string')
    writeFileSync(args.json, JSON.stringify({ results, funnel, series }, null, 1));
  console.log(report);

  if (args.db) {
    const { storeRun } = await import('./backtest-db.mjs');
    await storeRun({
      url: process.env.DATABASE_URL,
      series,
      results,
      range,
      criteria: CRITERIA,
      outcomes: allOutcomes,
      publishCohorts: args['publish-cohorts'] === true,
    });
    console.error(
      args['publish-cohorts'] === true
        ? 'stored backtest_runs and BACKTEST cohort rows'
        : 'stored backtest_runs (cohort rows not published)',
    );
  }
}

if (process.argv[1]?.endsWith('backtest.mjs')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
