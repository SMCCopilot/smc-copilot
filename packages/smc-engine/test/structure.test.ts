import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../src/index.js';
import { config, INSTRUMENT, run } from './helpers.js';
import { WORKED_BASE_OPEN_MS, WORKED_ROWS } from './worked-example.js';

const T0 = WORKED_BASE_OPEN_MS;
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/** The worked example's parameters: internal L=R=2, ATR fixed at 100 (A04 section 15.5). */
const workedCfg = () =>
  config((c) => {
    (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
    (c.atr as { fixed?: number }).fixed = 100;
  });

const internal = (events: EngineEvent[]) => events.filter((e) => e.scale === 'internal');

describe('worked example (golden fixture 0): swings and structure', () => {
  const events = internal(run(WORKED_ROWS, workedCfg(), { start: T0 }));
  const of = (type: EngineEvent['type']) => events.filter((e) => e.type === type);

  it('confirms swing high idx 2 (64450) at 04:15, not earlier', () => {
    const first = of('SWING_HIGH')[0] as EngineEvent;
    expect(first.data.level).toBe(64450);
    expect(first.anchorOpenTime).toBe(T0 + 2 * 900_000);
    expect(hhmm(first.time)).toBe('04:15');
  });

  it('confirms the lower high idx 7 (64300) at 05:30', () => {
    const lh = of('SWING_HIGH').find((e) => e.data.level === 64300) as EngineEvent;
    expect(hhmm(lh.time)).toBe('05:30');
  });

  it('confirms swing low 64030 at 06:00 and the lower low 64020 at 06:45', () => {
    const lows = of('SWING_LOW');
    expect(lows.slice(0, 2).map((e) => [e.data.level, hhmm(e.time)])).toEqual([
      [64030, '06:00'],
      [64020, '06:45'],
    ]);
  });

  it('turns the internal trend BEAR at 06:45 with protected high 64300', () => {
    const init = of('TREND_INIT')[0] as EngineEvent;
    expect(init.data).toMatchObject({ trend: 'BEAR', protectedLevel: 64300 });
    expect(hhmm(init.time)).toBe('06:45');
  });

  it('emits CHOCH_UP at 07:45 on idx 18 with displacement (2.6 ATR)', () => {
    const choch = of('CHOCH_UP');
    expect(choch).toHaveLength(1);
    const e = choch[0] as EngineEvent;
    expect(hhmm(e.time)).toBe('07:45');
    expect(e.anchorOpenTime).toBe(T0 + 18 * 900_000);
    expect(e.data).toMatchObject({
      brokenLevel: 64300,
      protectedLevel: 64300,
      displacement: true,
      multiBreak: false,
      gapBreak: false,
    });
    expect(e.data.bodyAtr).toBeCloseTo(2.6, 10);
  });

  it('breaks structure first with the CHoCH; later BOS_UPs come only when 64400 and 64450 close', () => {
    const breaks = events.filter((e) => /^(BOS|CHOCH)/.test(e.type));
    expect(breaks.map((e) => [e.type, hhmm(e.time)])).toEqual([
      ['CHOCH_UP', '07:45'],
      ['BOS_UP', '09:15'],
      ['BOS_UP', '09:30'],
    ]);
  });

  it('keeps every event at or after the close of the bars it depends on', () => {
    for (const e of events) expect(e.time).toBeGreaterThanOrEqual(e.anchorOpenTime + 900_000);
  });

  it('gives events stable ids that include the instrument', () => {
    const again = internal(run(WORKED_ROWS, workedCfg(), { start: T0 }));
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(INSTRUMENT).toContain('BTCUSDT');
  });
});

const small = () =>
  config((c) => {
    (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
    (c.swings as { external: { L: number; R: number } }).external = { L: 4, R: 4 };
    (c.atr as { fixed?: number }).fixed = 10;
  });
// rows from highs/lows/closes; open = previous close
const rows = (hlc: [number, number, number][]): [number, number, number, number][] =>
  hlc.map(([h, l, c], i) => [i === 0 ? c : (hlc[i - 1] as [number, number, number])[2], h, l, c]);

describe('swing rules', () => {
  it('ties: the earlier of two equal highs is the pivot, the later is not a second swing', () => {
    const ev = run(
      rows([
        [10, 5, 8],
        [11, 6, 9],
        [15, 7, 12],
        [15, 8, 12],
        [12, 8, 10],
        [11, 7, 9],
        [10, 6, 8],
      ]),
      small(),
    );
    const highs = internal(ev).filter((e) => e.type === 'SWING_HIGH');
    expect(highs).toHaveLength(1);
    expect(highs[0]?.anchorOpenTime).toBe(2 * 900_000);
  });

  it('needs R bars after the pivot: nothing is emitted one bar early', () => {
    const ev = run(
      rows([
        [10, 5, 8],
        [11, 6, 9],
        [15, 7, 12],
        [12, 8, 10],
      ]),
      small(),
    );
    expect(internal(ev).filter((e) => e.type === 'SWING_HIGH')).toHaveLength(0);
  });
});

describe('structure rules', () => {
  const edit = (idx: number, row: [number, number, number, number], upTo = 20) => {
    const r = WORKED_ROWS.slice(0, upTo).map((x) => [...x] as [number, number, number, number]);
    r[idx] = row;
    return r;
  };
  const wickRows = () => {
    const r = edit(18, [64060, 64330, 64050, 64290]);
    r[19] = [64290, 64295, 64270, 64280];
    return r;
  };

  it('a wick through the protected high is not a break when a close is required', () => {
    const ev = internal(run(wickRows(), workedCfg(), { start: T0 }));
    expect(ev.some((e) => /^(BOS|CHOCH)/.test(e.type))).toBe(false);
  });

  it('a wick break counts when requireCloseBeyond is off', () => {
    const cfg = config((c) => {
      (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
      (c.atr as { fixed?: number }).fixed = 100;
      (c.break as { requireCloseBeyond: boolean }).requireCloseBeyond = false;
    });
    const ev = internal(run(wickRows(), cfg, { start: T0 }));
    expect(ev.some((e) => e.type === 'CHOCH_UP')).toBe(true);
  });

  it('flags a gap break when the break candle opens more than 1 ATR from the prior close', () => {
    const ev = internal(run(edit(18, [64200, 64330, 64050, 64320]), workedCfg(), { start: T0 }));
    const brk = ev.find((e) => e.type === 'CHOCH_UP');
    expect(brk?.data.gapBreak).toBe(true);
  });

  it('flags multiBreak when one close passes several unbroken highs', () => {
    const ev = internal(run(edit(18, [64060, 64500, 64050, 64480]), workedCfg(), { start: T0 }));
    const brk = ev.find((e) => e.type === 'CHOCH_UP');
    expect(brk?.data.multiBreak).toBe(true);
  });
});

describe('engine guards', () => {
  it('ignores a candle at or before the last processed open time and open candles', () => {
    const cfg = small();
    const r = rows([
      [10, 5, 8],
      [11, 6, 9],
    ]);
    const once = run(r, cfg);
    const dup = run([...r, ...r.slice(0, 1)], cfg);
    expect(dup).toEqual(once);
  });
});

describe('break buffer', () => {
  it('requires the close to clear the level by bufferAtrMult x ATR', () => {
    const buffered = config((c) => {
      (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
      (c.atr as { fixed?: number }).fixed = 100;
      (c.break as { bufferAtrMult: number }).bufferAtrMult = 1; // needs a close above 64300 + 100
    });
    const ev = run(WORKED_ROWS.slice(0, 20), buffered, { start: T0 }).filter(
      (e) => e.scale === 'internal',
    );
    expect(ev.some((e) => e.type === 'CHOCH_UP')).toBe(false);
  });
});
