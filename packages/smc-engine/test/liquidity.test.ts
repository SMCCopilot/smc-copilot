import { describe, expect, it } from 'vitest';
import { dayStartOf, weekStartOf } from '../src/liquidity.js';
import { config, run } from './helpers.js';
import { WORKED_BASE_OPEN_MS, WORKED_ROWS } from './worked-example.js';

const T0 = WORKED_BASE_OPEN_MS;
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const idx = (ms: number): number => (ms - T0) / 900_000;

const cfg = () =>
  config((c) => {
    (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
    (c.atr as { fixed?: number }).fixed = 100;
  });

describe('worked example: liquidity', () => {
  const events = run(WORKED_ROWS, cfg(), { start: T0 });

  it('forms the EQL pool at 64020 (strength 2) when the second low confirms at 06:45', () => {
    const pool = events.find((e) => e.type === 'POOL_NEW' && e.data.kind === 'EQL');
    expect(pool?.data).toMatchObject({ level: 64020, strength: 2, side: 'SELL' });
    expect(hhmm(pool?.time as number)).toBe('06:45');
  });

  it('reports the sweep at 07:15 with sweepExtreme 63960 (idx 16 wick, closes back inside)', () => {
    const sweeps = events.filter((e) => e.type === 'LIQ_SWEEP');
    expect(sweeps).toHaveLength(1);
    const s = sweeps[0];
    expect(hhmm(s?.time as number)).toBe('07:15');
    expect(idx(s?.anchorOpenTime as number)).toBe(16);
    expect(s?.data).toMatchObject({ sweepExtreme: 63960, level: 64020, poolKind: 'EQL' });
  });

  it('treats a close beyond the pool that is not reversed in 3 bars as a run, not a sweep', () => {
    const rows = WORKED_ROWS.slice(0, 19).map((r) => [...r] as [number, number, number, number]);
    rows[16] = [64080, 64120, 63960, 63990];
    rows[17] = [63990, 64010, 63950, 63980];
    rows[18] = [63980, 64000, 63940, 63970];
    const ev = run(rows, cfg(), { start: T0 });
    expect(ev.some((e) => e.type === 'LIQ_SWEEP')).toBe(false);
    const run1 = ev.find((e) => e.type === 'LIQ_RUN');
    expect(run1).toBeDefined();
    expect(hhmm(run1?.time as number)).toBe('07:45');
    expect(run1?.data.sweepExtreme).toBe(63940);
  });

  it('does not sweep when the wick pierces by less than the minimum', () => {
    const rows = WORKED_ROWS.slice(0, 19).map((r) => [...r] as [number, number, number, number]);
    rows[16] = [64080, 64120, 64018, 64100]; // 2 below 64020, minimum is 5
    const ev = run(rows, cfg(), { start: T0 });
    expect(ev.some((e) => e.type === 'LIQ_SWEEP' || e.type === 'LIQ_RUN')).toBe(false);
  });
});

describe('previous day and week levels', () => {
  const HOUR = 3_600_000;
  const mk = (start: number, rows: [number, number, number, number][]) =>
    run(rows, cfg(), { tf: '1h', tfMs: HOUR, start });

  it('knows UTC day and Monday week boundaries', () => {
    const mon = Date.UTC(2026, 9, 12);
    expect(new Date(mon).getUTCDay()).toBe(1);
    expect(weekStartOf(mon + 5 * HOUR)).toBe(mon);
    expect(weekStartOf(mon - HOUR)).toBe(mon - 7 * 86_400_000);
    expect(dayStartOf(mon + 23 * HOUR)).toBe(mon);
  });

  it('creates PDH/PDL at the first candle of the next UTC day', () => {
    const start = Date.UTC(2026, 9, 13, 22); // Tuesday 22:00
    const ev = mk(start, [
      [105, 110, 100, 106],
      [106, 115, 102, 108],
      [108, 109, 104, 108],
    ]);
    const kinds = ev
      .filter((e) => e.type === 'POOL_NEW')
      .map((e) => [e.data.kind, e.data.level, e.data.side]);
    expect(kinds).toEqual([
      ['PDH', 115, 'BUY'],
      ['PDL', 100, 'SELL'],
    ]);
  });

  it('also creates PWH/PWL when the Monday week rolls', () => {
    const start = Date.UTC(2026, 9, 11, 23); // Sunday 23:00
    const ev = mk(start, [
      [105, 120, 95, 106],
      [106, 109, 104, 108],
    ]);
    expect(
      ev
        .filter((e) => e.type === 'POOL_NEW')
        .map((e) => e.data.kind)
        .sort(),
    ).toEqual(['PDH', 'PDL', 'PWH', 'PWL']);
  });

  it('sweeps PDH when a later wick exceeds it and closes back inside', () => {
    const start = Date.UTC(2026, 9, 13, 22);
    const ev = mk(start, [
      [105, 110, 100, 106],
      [106, 115, 102, 108],
      [108, 109, 104, 108],
      [108, 120, 107, 112],
    ]);
    const s = ev.find((e) => e.type === 'LIQ_SWEEP');
    expect(s?.data).toMatchObject({ poolKind: 'PDH', level: 115, sweepExtreme: 120 });
  });
});
