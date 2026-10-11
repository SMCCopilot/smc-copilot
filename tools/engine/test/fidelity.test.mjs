import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, feed } from '@smc/smc-engine';
import { describe, expect, it } from 'vitest';
import { evaluate, itemsFromEvents, renderReport, TARGETS } from '../src/fidelity.mjs';
import { buildPack, mulberry32, pickWindows } from '../src/label-pack.mjs';
import { loadConfig } from '../src/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(join(here, '../configs/smc-core-v1.json'), 'fidelity-test');
const INSTRUMENT = 'BINANCE:SPOT:BTCUSDT';

function candles(n, seed = 5, tf = '15m', start = Date.UTC(2026, 9, 12)) {
  const ms = { '15m': 900_000, '1h': 3_600_000 }[tf];
  const rnd = mulberry32(seed);
  let p = 60_000;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    const c = Math.max(1000, o + Math.floor((rnd() - 0.5) * 200));
    p = c;
    return {
      instrumentId: INSTRUMENT,
      tf,
      openTime: start + i * ms,
      o,
      h: Math.max(o, c) + Math.floor(rnd() * 70),
      l: Math.max(1, Math.min(o, c) - Math.floor(rnd() * 70)),
      c,
      v: 1,
      closed: true,
      providerId: 't',
    };
  });
}

const chart = { id: '15m-01', tf: '15m', instrumentId: INSTRUMENT, candles: candles(400) };
/** A "perfect labeler": labels equal to what the engine detects. */
const perfect = () => {
  const events = feed(createEngine(INSTRUMENT), chart.candles, cfg).events;
  return itemsFromEvents(events, chart).map((i) => ({ chartId: chart.id, ...i }));
};

describe('evaluate', () => {
  it('scores a perfect labeler at 100% in every family that has data', () => {
    const labels = perfect();
    const r = evaluate(labels, [chart], cfg);
    for (const g of Object.values(r.gate)) {
      if (g.agreement !== null) expect(g.agreement).toBe(1);
    }
    expect(Object.values(r.gate).filter((g) => g.agreement !== null).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(r.misses).toEqual([]);
    expect(r.extras).toEqual([]);
  });

  it('counts an engine detection the human did not label as an extra and lowers precision', () => {
    const labels = perfect().filter((l) => l.index >= 25);
    const dropped = labels.find((l) => l.kind === 'FVG');
    const r = evaluate(
      labels.filter((l) => l !== dropped),
      [chart],
      cfg,
    );
    expect(r.gate.fvg.fp).toBe(1);
    expect(r.extras.some((x) => x.kind === 'FVG')).toBe(true);
    expect(r.gate.fvg.agreement).toBeLessThan(1);
  });

  it('counts a spurious label as a miss', () => {
    const labels = [...perfect(), { chartId: chart.id, kind: 'OB', dir: 'BULL', index: 300 }];
    const r = evaluate(labels, [chart], cfg);
    expect(r.misses.at(-1)).toMatchObject({ kind: 'OB', index: 300 });
  });

  it('allows one bar of slack for swings but none for FVG', () => {
    const base = perfect().filter((l) => l.index >= 25);
    const swing = base.find((l) => l.kind === 'SWING_HIGH' && l.scale === 'external');
    const fvg = base.find((l) => l.kind === 'FVG');
    const shift = (target, by) =>
      base.map((l) => (l === target ? { ...l, index: l.index + by } : l));
    expect(evaluate(shift(swing, 1), [chart], cfg).gate.swings.fn).toBe(0);
    expect(evaluate(shift(swing, 2), [chart], cfg).gate.swings.fn).toBe(1);
    expect(evaluate(shift(fvg, 1), [chart], cfg).gate.fvg.fn).toBe(1);
  });

  it('does not match across directions or scales', () => {
    const base = perfect().filter((l) => l.index >= 25);
    const ob = base.find((l) => l.kind === 'OB');
    const flipped = base.map((l) =>
      l === ob ? { ...l, dir: l.dir === 'BULL' ? 'BEAR' : 'BULL' } : l,
    );
    const r = evaluate(flipped, [chart], cfg);
    expect(r.gate.ob.fn).toBeGreaterThanOrEqual(1);
  });

  it('ignores the start margin on both sides and reports no data as null, not 0%', () => {
    const r = evaluate([], [{ ...chart, candles: chart.candles.slice(0, 30) }], cfg, {
      margin: 25,
    });
    for (const g of Object.values(r.gate)) expect(g.pass).toBe(false);
    expect(Object.values(r.gate).every((g) => g.agreement === null || g.agreement === 0)).toBe(
      true,
    );
  });

  it('renders a report with the gate table and the targets', () => {
    const r = evaluate(perfect(), [chart], cfg);
    const md = renderReport(r, { packId: 'p1', labelCount: 3, chartCount: 1, configId: 'x' });
    expect(md).toContain('# Engine fidelity report (gate G1)');
    expect(md).toContain('PASS');
    for (const t of Object.values(TARGETS)) expect(md).toContain(`${(t * 100).toFixed(1)}%`);
  });
});

describe('label packs', () => {
  it('picks the same non-overlapping windows for the same seed', () => {
    const a = pickWindows(7, 200, 2000, 3);
    expect(pickWindows(7, 200, 2000, 3)).toEqual(a);
    const sorted = [...a].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(200);
    expect(pickWindows(5, 200, 100, 1)).toEqual([]);
    expect(pickWindows(50, 200, 1000, 1).length).toBe(5);
  });

  it('cuts charts per timeframe with stable ids and no gaps inside a chart', () => {
    const all = [...candles(1200, 1, '15m'), ...candles(1200, 2, '1h')];
    const pack = buildPack(all, { tfs: ['15m', '1h'], perTf: 3, bars: 200, seed: 1, packId: 'p' });
    expect(pack.charts.map((c) => c.id)).toEqual([
      '15m-01',
      '15m-02',
      '15m-03',
      '1h-01',
      '1h-02',
      '1h-03',
    ]);
    for (const c of pack.charts) {
      expect(c.candles).toHaveLength(200);
      for (let i = 1; i < c.candles.length; i++) {
        expect(c.candles[i].openTime - c.candles[i - 1].openTime).toBe(
          c.tf === '15m' ? 900_000 : 3_600_000,
        );
      }
    }
  });

  it('writes a self-contained labeling page and scores labels end to end via the CLIs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'label-pack-'));
    try {
      const file = join(dir, 'candles.json');
      writeFileSync(file, JSON.stringify(candles(900, 9, '15m')));
      const run = (script, args) =>
        spawnSync(process.execPath, [join(here, '../src', script), ...args], { encoding: 'utf8' });
      const made = run('label-pack.mjs', [
        '--candles',
        file,
        '--out',
        dir,
        '--tfs',
        '15m',
        '--per-tf',
        '2',
        '--bars',
        '300',
      ]);
      expect(made.status, made.stderr).toBe(0);
      const html = readFileSync(join(dir, 'label.html'), 'utf8');
      expect(html).not.toContain('/*PACK_JSON*/');
      expect(html).toContain('"packId"');
      expect(html).not.toMatch(/https?:\/\//); // works offline, no external requests

      const pack = JSON.parse(readFileSync(join(dir, 'charts.json'), 'utf8'));
      const labels = [];
      for (const c of pack.charts) {
        const ev = feed(createEngine(INSTRUMENT), c.candles, cfg).events;
        for (const i of itemsFromEvents(ev, c)) labels.push({ chartId: c.id, ...i });
      }
      writeFileSync(join(dir, 'labels.json'), JSON.stringify({ packId: pack.packId, labels }));
      const scored = run('fidelity-cli.mjs', [
        '--pack',
        join(dir, 'charts.json'),
        '--labels',
        join(dir, 'labels.json'),
        '--report',
        join(dir, 'r.md'),
      ]);
      expect(scored.status, scored.stderr).toBe(0);
      expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain('PASS');

      writeFileSync(join(dir, 'other.json'), JSON.stringify({ packId: 'different', labels: [] }));
      const wrong = run('fidelity-cli.mjs', [
        '--pack',
        join(dir, 'charts.json'),
        '--labels',
        join(dir, 'other.json'),
      ]);
      expect(wrong.status).toBe(2);
      expect(wrong.stderr).toMatch(/different/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
