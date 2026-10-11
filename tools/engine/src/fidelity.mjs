// Detector fidelity (A04 section 15.4): compare engine detections with human labels on the same candles.
// "Agreement" is the F1 score of one-to-one matches; precision and recall are reported alongside it.
import { TIMEFRAME_MS } from '@smc/contracts';
import { createEngine, feed } from '@smc/smc-engine';

/** A04 / B05 gate G1 targets, as agreement fractions. */
export const TARGETS = { swings: 0.9, structure: 0.9, fvg: 0.95, ob: 0.7 };
/** Allowed distance in bars between a label and a detection. FVG is a precise geometric rule: exact. */
export const TOLERANCE = { SWING_HIGH: 1, SWING_LOW: 1, BOS: 1, CHOCH: 1, FVG: 0, OB: 1 };
export const FAMILY = {
  SWING_HIGH: 'swings',
  SWING_LOW: 'swings',
  BOS: 'structure',
  CHOCH: 'structure',
  FVG: 'fvg',
  OB: 'ob',
};
/** Bars at the start of a chart are excluded on both sides: the engine has no left context there. */
export const DEFAULT_MARGIN = 25;

/** Engine events as comparable items (kind, direction, scale, bar index within the chart). */
export function itemsFromEvents(events, chart) {
  const tfMs = TIMEFRAME_MS[chart.tf];
  const t0 = chart.candles[0].openTime;
  const out = [];
  for (const e of events) {
    const index = (e.anchorOpenTime - t0) / tfMs;
    let item = null;
    if (e.type === 'SWING_HIGH' || e.type === 'SWING_LOW') item = { kind: e.type, scale: e.scale };
    else if (/^(BOS|CHOCH)_(UP|DOWN)$/.test(e.type)) {
      const [kind, dir] = e.type.split('_');
      item = { kind, dir, scale: e.scale };
    } else if (e.type === 'FVG_BULL' || e.type === 'FVG_BEAR') {
      item = { kind: 'FVG', dir: e.type.endsWith('BULL') ? 'BULL' : 'BEAR' };
    } else if (e.type === 'OB_BULL' || e.type === 'OB_BEAR') {
      item = { kind: 'OB', dir: e.type.endsWith('BULL') ? 'BULL' : 'BEAR' };
    }
    if (item) out.push({ ...item, index });
  }
  return out;
}

const groupKey = (x) => [x.kind, x.dir ?? '', x.scale ?? ''].join('|');

/** One-to-one nearest matching inside a group. Returns indices of matched labels and detections. */
function matchGroup(labels, detections, tol) {
  const pairs = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < detections.length; j++) {
      const dist = Math.abs(labels[i].index - detections[j].index);
      if (dist <= tol) pairs.push({ i, j, dist });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist || a.i - b.i || a.j - b.j);
  const usedL = new Set();
  const usedD = new Set();
  for (const p of pairs) {
    if (usedL.has(p.i) || usedD.has(p.j)) continue;
    usedL.add(p.i);
    usedD.add(p.j);
  }
  return { usedL, usedD };
}

const ratio = (a, b) => (b === 0 ? null : a / b);

/**
 * @param {{ chartId: string, kind: string, index: number, dir?: string, scale?: string }[]} labels
 * @param {{ id: string, tf: string, candles: object[] }[]} charts
 * @param {object} cfg parsed StrategyConfig
 */
export function evaluate(labels, charts, cfg, { margin = DEFAULT_MARGIN } = {}) {
  const tally = {};
  const bump = (family, scale, field) => {
    const key = scale ? `${family}:${scale}` : family;
    tally[key] ??= { family, scale: scale ?? null, tp: 0, fp: 0, fn: 0 };
    tally[key][field]++;
  };
  const misses = [];
  const extras = [];

  for (const chart of charts) {
    const events = feed(createEngine(chart.candles[0].instrumentId), chart.candles, cfg).events;
    // The last R bars of a chart cannot confirm a pivot, so both sides ignore them as well.
    const last = chart.candles.length - 1 - cfg.swings.external.R;
    const inScope = (x) => x.index >= margin && x.index <= last;
    const detections = itemsFromEvents(events, chart).filter(inScope);
    const mine = labels.filter((l) => l.chartId === chart.id && inScope(l));

    const keys = new Set([...mine.map(groupKey), ...detections.map(groupKey)]);
    for (const key of keys) {
      const ls = mine.filter((l) => groupKey(l) === key);
      const ds = detections.filter((d) => groupKey(d) === key);
      const kind = (ls[0] ?? ds[0]).kind;
      const family = FAMILY[kind];
      const scale = (ls[0] ?? ds[0]).scale;
      const { usedL, usedD } = matchGroup(ls, ds, TOLERANCE[kind]);
      for (let i = 0; i < ls.length; i++) {
        if (usedL.has(i)) bump(family, scale, 'tp');
        else {
          bump(family, scale, 'fn');
          misses.push({ chartId: chart.id, ...ls[i] });
        }
      }
      for (let j = 0; j < ds.length; j++) {
        if (!usedD.has(j)) {
          bump(family, scale, 'fp');
          extras.push({ chartId: chart.id, ...ds[j] });
        }
      }
    }
  }

  const rows = Object.values(tally)
    .map((r) => {
      const precision = ratio(r.tp, r.tp + r.fp);
      const recall = ratio(r.tp, r.tp + r.fn);
      const agreement = r.tp + r.fp + r.fn === 0 ? null : (2 * r.tp) / (2 * r.tp + r.fp + r.fn);
      return { ...r, precision, recall, agreement };
    })
    .sort(
      (a, b) => a.family.localeCompare(b.family) || String(a.scale).localeCompare(String(b.scale)),
    );

  // Family totals decide the gate (swings pooled over both scales).
  const families = {};
  for (const r of rows) {
    families[r.family] ??= { tp: 0, fp: 0, fn: 0 };
    families[r.family].tp += r.tp;
    families[r.family].fp += r.fp;
    families[r.family].fn += r.fn;
  }
  const gate = {};
  for (const [family, target] of Object.entries(TARGETS)) {
    const f = families[family] ?? { tp: 0, fp: 0, fn: 0 };
    const total = f.tp + f.fp + f.fn;
    const agreement = total === 0 ? null : (2 * f.tp) / (2 * f.tp + f.fp + f.fn);
    gate[family] = { ...f, agreement, target, pass: agreement !== null && agreement >= target };
  }
  return { rows, gate, misses, extras, margin };
}

export const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function renderReport(result, { packId, labelCount, chartCount, configId }) {
  const lines = [
    '# Engine fidelity report (gate G1)',
    '',
    `Pack \`${packId}\`: ${chartCount} charts, ${labelCount} human labels, strategy \`${configId}\`.`,
    `The first ${result.margin} bars of each chart are excluded on both sides (no left context for the engine).`,
    'Agreement is the F1 score of one-to-one matches (tolerance in bars: swings and structure 1, order blocks 1, FVG 0).',
    '',
    '## Gate',
    '',
    '| Family | Labels matched | Engine extras | Labels missed | Agreement | Target | Result |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(result.gate).map(
      ([family, g]) =>
        `| ${family} | ${g.tp} | ${g.fp} | ${g.fn} | ${pct(g.agreement)} | ${pct(g.target)} | ${
          g.agreement === null ? 'no data' : g.pass ? 'PASS' : 'FAIL'
        } |`,
    ),
    '',
    '## Detail',
    '',
    '| Family | Scale | TP | FP | FN | Precision | Recall | Agreement |',
    '|---|---|---|---|---|---|---|---|',
    ...result.rows.map(
      (r) =>
        `| ${r.family} | ${r.scale ?? '-'} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.agreement)} |`,
    ),
    '',
    '## Labels the engine missed',
    '',
    ...(result.misses.length === 0
      ? ['None.']
      : result.misses.map((m) =>
          `- ${m.chartId} bar ${m.index}: ${m.kind} ${m.dir ?? ''} ${m.scale ?? ''}`.trimEnd(),
        )),
    '',
    '## Engine detections with no label',
    '',
    ...(result.extras.length === 0
      ? ['None.']
      : result.extras.map((m) =>
          `- ${m.chartId} bar ${m.index}: ${m.kind} ${m.dir ?? ''} ${m.scale ?? ''}`.trimEnd(),
        )),
    '',
  ];
  return lines.join('\n');
}
