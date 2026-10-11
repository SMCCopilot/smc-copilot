import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCandles } from '../src/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../src/replay.mjs');
const fx = (name) => join(here, 'fixtures', name);
const run = (args) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '' },
  });

describe('engine:replay', () => {
  const base = [
    '--candles',
    fx('worked-example.candles.json'),
    '--config',
    fx('worked-example.config.json'),
    '--version-id',
    'test-v1', // event ids include the strategy version, so it must match the engine golden test
  ];

  it('replays the worked example deterministically (same hash twice)', () => {
    const a = JSON.parse(run(base).stdout);
    const b = JSON.parse(run(base).stdout);
    expect(a.streamHash).toBe(b.streamHash);
    expect(a.candles).toBe(26);
    expect(a.counts).toMatchObject({ CHOCH_UP: 1, LIQ_SWEEP: 1, OB_BULL: 2, FVG_BULL: 3 });
  });

  it('matches the hash pinned by the engine golden test', () => {
    const snap = readFileSync(
      join(here, '../../../packages/smc-engine/test/__snapshots__/facts-golden.test.ts.snap'),
      'utf8',
    );
    const pinned = snap
      .split('worked example (golden 0) hash is pinned')[1]
      ?.match(/"hash": "([0-9a-f]{40})"/)?.[1];
    expect(JSON.parse(run(base).stdout).streamHash).toBe(pinned);
  });

  it('exits 1 on an --expect-hash mismatch and 0 on a match', () => {
    const hash = JSON.parse(run(base).stdout).streamHash;
    expect(run([...base, '--expect-hash', hash]).status).toBe(0);
    expect(run([...base, '--expect-hash', 'deadbeef']).status).toBe(1);
  });

  it('writes events and facts on request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-replay-'));
    try {
      const out = join(dir, 'e.ndjson');
      const r = JSON.parse(run([...base, '--events', out, '--facts']).stdout);
      expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(r.events);
      expect(r.facts.instrumentId).toBe('BINANCE:SPOT:BTCUSDT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses invalid candles and missing input with a clear message', () => {
    expect(() => parseCandles('[{"instrumentId":"X"}]')).toThrow(/candle #0 is invalid/);
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--candles/);
    expect(run(['--db', '--instrument', 'a', '--from', 'b', '--to', 'c']).stderr).toMatch(
      /DATABASE_URL/,
    );
  });

  it('keeps the shipped smc-core-v1 config identical to the seeded migration JSON', () => {
    const sql = readFileSync(
      join(here, '../../../packages/db/migrations/0009_seed_reference.sql'),
      'utf8',
    );
    const seeded = JSON.parse(sql.match(/\$cfg\$([\s\S]*?)\$cfg\$/)[1]);
    expect(JSON.parse(readFileSync(join(here, '../configs/smc-core-v1.json'), 'utf8'))).toEqual(
      seeded,
    );
  });
});
