// Backtest helpers: events -> trades and a setup funnel, plus the markdown report.
import { summarizeCohorts } from '@smc/analytics';

export const DEFAULT_TICKS = {
  'BINANCE:SPOT:BTCUSDT': 0.01,
  'BINANCE:PERP:BTCUSDT': 0.1,
  'BINANCE:SPOT:ETHUSDT': 0.01,
  'BINANCE:PERP:ETHUSDT': 0.01,
};

/**
 * Walks the event stream of one series.
 * - `trades`: filled and resolved (TP1 first or stopped) with net R, for the expectancy maths.
 * - `outcomes`: one row per armed setup that resolved in any way, for cohort statistics.
 * - `funnel`: how many candidates became what, and why the rest were rejected.
 */
export function collectFromEvents(events, range) {
  const armed = new Map();
  const funnel = {
    candidates: 0,
    rejected: 0,
    armed: 0,
    triggered: 0,
    byReason: {},
    outcomes: {},
    ambiguous: 0,
    byTemplate: {},
  };
  const trades = [];
  const outcomes = [];
  const inRange = (t) => t >= range.from && t < range.to;
  for (const e of events) {
    const k = e.data.setupKey;
    if (e.type === 'SETUP_CANDIDATE' && inRange(e.time)) {
      funnel.candidates++;
    } else if (e.type === 'SETUP_REJECTED' && inRange(e.time)) {
      funnel.rejected++;
      for (const r of e.data.reasonCodes) funnel.byReason[r] = (funnel.byReason[r] ?? 0) + 1;
    } else if (e.type === 'SETUP_ARMED') {
      armed.set(k, {
        template: e.data.template,
        grade: e.data.grade,
        direction: e.data.direction,
        createdAt: e.time,
      });
      if (inRange(e.time)) {
        funnel.armed++;
        funnel.byTemplate[e.data.template] = (funnel.byTemplate[e.data.template] ?? 0) + 1;
      }
    } else if (e.type === 'SETUP_TRIGGERED' && armed.has(k) && inRange(armed.get(k).createdAt)) {
      funnel.triggered++;
    } else if (e.type === 'SETUP_RESOLVED') {
      const a = armed.get(k);
      if (!a || !inRange(a.createdAt)) continue;
      funnel.outcomes[e.data.outcome] = (funnel.outcomes[e.data.outcome] ?? 0) + 1;
      if (e.data.ambiguousIntrabar) funnel.ambiguous++;
      outcomes.push({
        template: a.template,
        grade: a.grade,
        direction: a.direction,
        outcome: e.data.outcome,
        filled: e.data.filled,
        realizedR: e.data.realizedR,
        mfeR: e.data.mfeR,
        maeR: e.data.maeR,
        ambiguousIntrabar: e.data.ambiguousIntrabar,
      });
      if (
        (e.data.outcome === 'TP1_FIRST' || e.data.outcome === 'SL_FIRST') &&
        e.data.realizedR !== null
      ) {
        trades.push({
          key: k,
          template: a.template,
          grade: a.grade,
          direction: a.direction,
          createdAt: a.createdAt,
          resolutionTime: e.data.resolutionTime,
          realizedR: e.data.realizedR,
          win: e.data.outcome === 'TP1_FIRST',
        });
      }
    }
  }
  return { trades, outcomes, funnel };
}

export function mergeFunnels(list) {
  const out = {
    candidates: 0,
    rejected: 0,
    armed: 0,
    triggered: 0,
    byReason: {},
    outcomes: {},
    ambiguous: 0,
    byTemplate: {},
  };
  for (const f of list) {
    for (const k of ['candidates', 'rejected', 'armed', 'triggered', 'ambiguous']) out[k] += f[k];
    for (const m of ['byReason', 'outcomes', 'byTemplate']) {
      for (const [key, v] of Object.entries(f[m])) out[m][key] = (out[m][key] ?? 0) + v;
    }
  }
  return out;
}

const fmt = (x, d = 3) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function groupRows(title, groups) {
  const lines = [
    `### ${title}`,
    '',
    '| Group | Trades | Win rate | Mean net R | CI of mean (adjusted) | Max drawdown R | Windows positive | Result |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const g of groups) {
    const ci = g.expectancyCi ? `[${fmt(g.expectancyCi[0])}, ${fmt(g.expectancyCi[1])}]` : 'n/a';
    lines.push(
      `| ${g.label} | ${g.n} | ${pct(g.winRate)} | ${fmt(g.expectancyR)} | ${ci} | ${fmt(g.maxDrawdownR, 2)} | ${g.positiveWindows}/${g.windows} | ${g.pass === null ? '-' : g.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  return lines;
}

export function renderReport({ results, funnel, series, meta }) {
  const L = [];
  L.push('# Backtest and outcomes report (gate G2)', '');
  L.push(
    `Strategy \`${meta.strategy}\`. Criteria were pre-registered in \`docs/backtest-criteria.md\` (commit ${meta.criteriaCommit}) before this run. Generated ${meta.generatedAt}.`,
    '',
  );
  L.push(
    '**This is a historical simulation, not a forecast.** It tests whether the rules as written had a positive net expectancy in this data, after costs.',
    '',
  );
  L.push(`## Verdict: **${results.verdict}**`, '');
  const note = {
    EDGE_SUPPORTED:
      'At least one template met every pre-registered criterion in the final-test period. That is evidence, not proof (see limits).',
    NO_EDGE_DETECTED:
      'Both templates had enough trades and neither met the pre-registered criteria. This is reported as is.',
    INSUFFICIENT_DATA:
      'No template reached the minimum number of trades in the final-test period, so there is no verdict either way.',
  }[results.verdict];
  L.push(note, '');
  L.push('## Data', '');
  L.push('| Series | Candles by timeframe |', '|---|---|');
  for (const s of series)
    L.push(
      `| ${s.id} | ${Object.entries(s.counts)
        .map(([tf, n]) => `${tf}: ${n}`)
        .join(', ')} |`,
    );
  L.push('');
  L.push(
    `Evaluated period ${day(meta.range.from)} to ${day(meta.range.to)} (UTC). Candles from ${day(meta.dataFrom)} warm up the engine; setups created before the evaluated period are not counted.`,
    '',
  );
  L.push(
    `Split: tune ${day(results.split.tune.from)} to ${day(results.split.tune.to)}, validate to ${day(results.split.validate.to)}, final test to ${day(results.split.test.to)}.`,
    `Trials counted: ${results.trialsCount}; adjusted alpha ${results.adjustedAlpha}; bootstrap seed ${results.seed}.`,
    '',
  );
  L.push('## Setup funnel (evaluated period)', '');
  L.push(
    `- candidates: ${funnel.candidates}`,
    `- rejected by hard filters: ${funnel.rejected}`,
    `- armed (got a shadow outcome): ${funnel.armed}`,
    `- triggered (touched the POI then a confirming break): ${funnel.triggered}`,
  );
  L.push(
    `- armed by template: ${
      Object.entries(funnel.byTemplate)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
  );
  L.push(
    `- rejection reasons: ${
      Object.entries(funnel.byReason)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
  );
  L.push(
    `- outcomes: ${
      Object.entries(funnel.outcomes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
  );
  const resolved = (funnel.outcomes.TP1_FIRST ?? 0) + (funnel.outcomes.SL_FIRST ?? 0);
  L.push(
    `- ambiguous intrabar (stop assumed first): ${funnel.ambiguous}${resolved ? ` (${pct(funnel.ambiguous / resolved)} of resolved)` : ''}`,
    '',
  );
  L.push(
    ...groupRows('Final test (evaluated against the criteria, looked at once)', results.test),
    '',
  );
  if (results.test.some((g) => g.failures.length)) {
    for (const g of results.test.filter((x) => x.failures.length))
      L.push(`- ${g.label}: ${g.failures.join('; ')}`);
    L.push('');
  }
  L.push(...groupRows('Validate (information only)', results.validate), '');
  L.push(...groupRows('Tune (information only)', results.tune), '');
  L.push('## Cohorts over the whole evaluated period', '');
  L.push(
    '| Template | Grade | Setups | Resolved | Win rate | 95% CI (Wilson) | Mean net R | Fill rate | Enough history |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const c of summarizeCohorts(meta.outcomes).filter((c) => c.direction === null)) {
    L.push(
      `| ${c.template} | ${c.grade} | ${c.setups} | ${c.n} | ${pct(c.n ? c.rate : null)} | ${c.n ? `[${pct(c.ci95[0])}, ${pct(c.ci95[1])}]` : 'n/a'} | ${fmt(c.avgR)} | ${pct(c.fillRate)} | ${c.sufficient ? 'yes' : 'no (n < 30)'} |`,
    );
  }
  L.push('', '## Limits', '');
  for (const s of meta.limits) L.push(`- ${s}`);
  L.push('');
  return L.join('\n');
}
