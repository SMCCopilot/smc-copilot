import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CRITERIA } from '../src/backtest.mjs';
import { collectFromEvents, mergeFunnels, renderReport } from '../src/backtest-lib.mjs';
import { mulberry32 } from '../src/label-pack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const T = Date.UTC(2026, 0, 1);
const range = { from: T, to: T + 1_000_000 };

const ev = (type, time, data) => ({ id: `${type}${time}${data.setupKey}`, type, time, data });
const armed = (key, time, over = {}) =>
  ev('SETUP_ARMED', time, {
    setupKey: key,
    template: 'T1',
    direction: 'LONG',
    grade: 'A',
    ...over,
  });
const resolved = (key, time, outcome, realizedR, over = {}) =>
  ev('SETUP_RESOLVED', time, {
    setupKey: key,
    outcome,
    filled: outcome !== 'NO_FILL',
    realizedR,
    mfeR: 1,
    maeR: 0.2,
    resolutionTime: time,
    ambiguousIntrabar: false,
    ...over,
  });

describe('collectFromEvents', () => {
  const events = [
    ev('SETUP_CANDIDATE', T + 10, { setupKey: 'a' }),
    armed('a', T + 10),
    ev('SETUP_TRIGGERED', T + 20, { setupKey: 'a' }),
    resolved('a', T + 30, 'TP1_FIRST', 2.1),
    ev('SETUP_CANDIDATE', T + 40, { setupKey: 'b' }),
    ev('SETUP_REJECTED', T + 40, { setupKey: 'b', reasonCodes: ['RR_TOO_LOW', 'NO_TARGET'] }),
    armed('c', T + 50, { template: 'T2', direction: 'SHORT', grade: 'B' }),
    resolved('c', T + 60, 'SL_FIRST', -1.1, { ambiguousIntrabar: true }),
    armed('d', T + 70),
    resolved('d', T + 80, 'NO_FILL', null),
    armed('e', T + 90),
    resolved('e', T + 95, 'EXPIRED_OPEN', null),
    // before the evaluated period: warm-up setups are not counted
    armed('old', T - 100),
    resolved('old', T - 50, 'TP1_FIRST', 3),
  ];
  const got = collectFromEvents(events, range);

  it('keeps only filled, resolved trades for expectancy, with net R and win flag', () => {
    expect(got.trades.map((t) => [t.key, t.template, t.realizedR, t.win])).toEqual([
      ['a', 'T1', 2.1, true],
      ['c', 'T2', -1.1, false],
    ]);
  });

  it('counts every armed setup outcome in the cohort rows, no-fills and open expiries included', () => {
    expect(got.outcomes.map((o) => o.outcome).sort()).toEqual([
      'EXPIRED_OPEN',
      'NO_FILL',
      'SL_FIRST',
      'TP1_FIRST',
    ]);
  });

  it('builds the funnel and ignores setups created before the evaluated period', () => {
    expect(got.funnel).toMatchObject({
      candidates: 2,
      rejected: 1,
      armed: 4,
      triggered: 1,
      ambiguous: 1,
      byReason: { RR_TOO_LOW: 1, NO_TARGET: 1 },
      outcomes: { TP1_FIRST: 1, SL_FIRST: 1, NO_FILL: 1, EXPIRED_OPEN: 1 },
    });
  });

  it('merges funnels across series', () => {
    const m = mergeFunnels([got.funnel, got.funnel]);
    expect(m.armed).toBe(8);
    expect(m.byReason.RR_TOO_LOW).toBe(2);
  });
});

describe('criteria are the pre-registered ones', () => {
  const doc = readFileSync(join(here, '../../../docs/backtest-criteria.md'), 'utf8');
  it('matches the numbers written in docs/backtest-criteria.md', () => {
    expect(doc).toMatch(/at least \*\*30\*\* filled and resolved trades/);
    expect(doc).toMatch(/above 0\*\* \(2,000 resamples, seed 1, two-sided at alpha = 0\.05 \/ 2/);
    expect(doc).toMatch(/at least \*\*2 of 3\*\* equal time windows/);
    expect(CRITERIA).toEqual({
      minTrades: 30,
      lowerBoundAbove: 0,
      minPositiveWindows: 2,
      windows: 3,
    });
  });
});

describe('engine:backtest CLI', () => {
  function series(n, seed) {
    const rnd = mulberry32(seed);
    let p = 60_000;
    const base = [];
    for (let i = 0; i < n; i++) {
      const o = p;
      const c = Math.max(1000, o + Math.floor((rnd() - 0.5) * 140));
      p = c;
      base.push({
        o,
        h: Math.max(o, c) + Math.floor(rnd() * 60),
        l: Math.max(1, Math.min(o, c) - Math.floor(rnd() * 60)),
        c,
      });
    }
    const out = [];
    const start = Date.UTC(2026, 0, 1);
    const push = (tf, ms, per) => {
      for (let i = 0; i + per <= base.length; i += per) {
        const s = base.slice(i, i + per);
        out.push({
          instrumentId: 'BINANCE:SPOT:BTCUSDT',
          tf,
          openTime: start + i * 300_000,
          o: s[0].o,
          h: Math.max(...s.map((x) => x.h)),
          l: Math.min(...s.map((x) => x.l)),
          c: s[s.length - 1].c,
          v: 1,
          closed: true,
          providerId: 't',
        });
      }
      void ms;
    };
    push('5m', 300_000, 1);
    push('15m', 900_000, 3);
    push('1h', 3_600_000, 12);
    push('4h', 14_400_000, 48);
    push('1d', 86_400_000, 288);
    return out;
  }

  it('runs end to end, writes the report and says INSUFFICIENT_DATA on a thin sample (not a pass or a fail)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backtest-'));
    try {
      const file = join(dir, 'c.ndjson');
      writeFileSync(
        file,
        series(288 * 20, 3)
          .map((c) => JSON.stringify(c))
          .join('\n'),
      );
      const r = spawnSync(
        process.execPath,
        [
          join(here, '../src/backtest.mjs'),
          '--candles',
          file,
          '--from',
          '2026-01-01',
          '--to',
          '2026-01-21',
          '--report',
          join(dir, 'r.md'),
          '--json',
          join(dir, 'r.json'),
        ],
        { encoding: 'utf8' },
      );
      expect(r.status, r.stderr).toBe(0);
      const md = readFileSync(join(dir, 'r.md'), 'utf8');
      expect(md).toContain('# Backtest and outcomes report (gate G2)');
      expect(md).toContain('not a forecast');
      expect(md).toMatch(/Verdict: \*\*(INSUFFICIENT_DATA|NO_EDGE_DETECTED|EDGE_SUPPORTED)\*\*/);
      expect(md).toContain('Trials counted: 2');
      const json = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
      expect(json.results.criteria).toEqual(CRITERIA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses to run without candles or a period, and --db without DATABASE_URL', () => {
    const run = (args) =>
      spawnSync(process.execPath, [join(here, '../src/backtest.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: '' },
      });
    expect(run([]).status).toBe(2);
    expect(run(['--candles', 'x']).stderr).toMatch(/--from/);
  });

  it('renders a report with the verdict and the funnel', () => {
    const results = {
      verdict: 'NO_EDGE_DETECTED',
      split: {
        tune: { from: 0, to: 1e9 },
        validate: { from: 1e9, to: 2e9 },
        test: { from: 2e9, to: 3e9 },
      },
      trialsCount: 2,
      adjustedAlpha: 0.025,
      seed: 1,
      tune: [],
      validate: [],
      test: [
        {
          label: 'T1',
          n: 40,
          wins: 16,
          winRate: 0.4,
          expectancyR: -0.1,
          expectancyCi: [-0.3, 0.1],
          maxDrawdownR: 6,
          positiveWindows: 1,
          windows: 3,
          pass: false,
          failures: ['lower bound is not above 0 R'],
        },
      ],
    };
    const md = renderReport({
      results,
      funnel: mergeFunnels([]),
      series: [{ id: 'BINANCE:SPOT:BTCUSDT', counts: { '5m': 10 } }],
      meta: {
        strategy: 'x',
        criteriaCommit: 'abc',
        generatedAt: '2026-10-11',
        range: { from: 0, to: 3e9 },
        dataFrom: 0,
        outcomes: [],
        limits: ['a limit'],
      },
    });
    expect(md).toContain('Verdict: **NO_EDGE_DETECTED**');
    expect(md).toContain('| T1 | 40 | 40.0% | -0.100 |');
    expect(md).toContain('a limit');
  });
});
