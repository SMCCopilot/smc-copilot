import { describe, expect, it } from 'vitest';
import { config, run } from './helpers.js';
import { WORKED_BASE_OPEN_MS, WORKED_ROWS } from './worked-example.js';

const T0 = WORKED_BASE_OPEN_MS;
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const idx = (ms: number): number => (ms - T0) / 900_000;

// Worked-example parameters: internal L=R=2, ATR fixed 100, fvg.minSize 0.25, displacement 1.5.
const cfg = () =>
  config((c) => {
    (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
    (c.atr as { fixed?: number }).fixed = 100;
    (c.fvg as { minSizeAtrMult: number }).minSizeAtrMult = 0.25;
  });
const events = () => run(WORKED_ROWS, cfg(), { start: T0 });

describe('worked example: zones', () => {
  it('creates the bullish OB from idx 17 at 07:45 with the WICK zone [64040, 64110]', () => {
    const ob = events().find((e) => e.type === 'OB_BULL' && e.data.breakScale === 'internal');
    expect(ob).toBeDefined();
    expect(hhmm(ob?.time as number)).toBe('07:45');
    expect(idx(ob?.anchorOpenTime as number)).toBe(17);
    expect(ob?.data).toMatchObject({ top: 64110, bottom: 64040, hasFvgInLeg: false });
    expect(ob?.data.sizeAtr).toBeCloseTo(0.7, 10);
  });

  it('confirms the bullish FVG [64110, 64270] at 08:00 (candles 17, 18, 19)', () => {
    const f = events().find((e) => e.type === 'FVG_BULL');
    expect(hhmm(f?.time as number)).toBe('08:00');
    expect(f?.data).toMatchObject({ top: 64270, bottom: 64110, ce: 64190, displacement: true });
    expect(f?.data.sizeAtr).toBeCloseTo(1.6, 10);
  });

  it('finds the other gaps the spec lists: bearish at idx 5 and 22, bullish at 24 and 25', () => {
    const gaps = events()
      .filter((e) => e.type === 'FVG_BULL' || e.type === 'FVG_BEAR')
      .map((e) => [e.type, idx(e.anchorOpenTime) + 1]);
    expect(gaps).toEqual(
      expect.arrayContaining([
        ['FVG_BEAR', 5],
        ['FVG_BULL', 19],
        ['FVG_BEAR', 22],
        ['FVG_BULL', 24],
        ['FVG_BULL', 25],
      ]),
    );
  });

  it('walks the FVG through TESTED then FILLED, each caused by a named candle', () => {
    const ev = events();
    const id = ev.find((e) => e.type === 'FVG_BULL')?.data.zoneId;
    const life = ev.filter((e) => e.data.zoneId === id && e.type !== 'FVG_BULL');
    expect(life.map((e) => [e.type, idx(e.data.causeOpenTime as number)])).toEqual([
      ['FVG_TESTED', 20],
      ['FVG_FILLED', 21],
    ]);
  });

  it('keeps the OB fresh until idx 22 trades into it (touch 1, 08:45); it is never mitigated', () => {
    const ev = events();
    const id = ev.find((e) => e.type === 'OB_BULL')?.data.zoneId;
    const life = ev.filter((e) => e.data.zoneId === id && e.type !== 'OB_BULL');
    expect(life.map((e) => [e.type, hhmm(e.time), e.data.touches])).toEqual([
      ['OB_TESTED', '08:45', 1],
    ]);
  });

  it('ignores gaps smaller than the ATR filter', () => {
    const strict = config((c) => {
      (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
      (c.atr as { fixed?: number }).fixed = 100;
      (c.fvg as { minSizeAtrMult: number }).minSizeAtrMult = 1.2;
    });
    const gaps = run(WORKED_ROWS, strict, { start: T0 }).filter((e) =>
      /^FVG_(BULL|BEAR)$/.test(e.type),
    );
    expect(gaps.map((e) => e.type)).toEqual(['FVG_BULL']);
  });
});
