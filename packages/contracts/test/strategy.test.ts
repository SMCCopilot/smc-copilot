import { describe, expect, it } from 'vitest';
import { parseStrategyConfig } from '../src/strategy.js';

const minimal = {
  schemaVersion: 1,
  timeframes: { analysis: ['15m'], bias: [], entry: ['15m'] },
  swings: { internal: { L: 3, R: 3 }, external: { L: 10, R: 10 } },
  atr: { period: 14 },
  break: { requireCloseBeyond: true, bufferAtrMult: 0 },
  displacement: { bodyAtrMult: 1.5, requireFvg: false },
  fvg: { minSizeAtrMult: 0.1, mitigation: 'TOUCH' },
  ob: { zoneBasis: 'WICK', requireDisplacement: true, maxAgeBars: 300 },
  liquidity: { equalTolAtrMult: 0.1, sweepMinAtrMult: 0.05, sweepConfirmBars: 3 },
  range: { basis: 'EXTERNAL_LEG', oteLow: 0.62, oteHigh: 0.79 },
  sessions: [],
  context: {
    openLevels: ['1d'],
    openLevelsAsTargets: false,
    weekendLiquidityWeight: -3,
    sessionsTz: 'UTC',
  },
  setups: { enabled: ['T1'], expiryBars: { '15m': 64 } },
  filters: {
    requireDataOk: true,
    requirePoiFresh: true,
    enforcePdSideT1: false,
    enforcePdSideT2: true,
    maxSpreadAtrMult: 0.2,
    volExtremePercentile: 98,
    newsWindow: false,
  },
  scoring: { weights: { htfAlignment: 20 }, gradeCuts: [50, 70] },
  risk: {
    takerFeeBps: 5,
    minRR: 1.5,
    stopBufferAtrMult: 0.1,
    maxStopAtrMult: 3,
    minStopAtrMult: 0.3,
  },
  rules: { bos: { status: 'HYPOTHESIS' } },
};

describe('parseStrategyConfig', () => {
  it('adds the version id and defaults the gap threshold', () => {
    const c = parseStrategyConfig('v1', minimal);
    expect(c.strategyVersionId).toBe('v1');
    expect(c.break.gapAtrMult).toBe(1);
  });
  it('rejects unknown keys and bad values', () => {
    expect(() => parseStrategyConfig('v1', { ...minimal, extra: 1 })).toThrow();
    expect(() =>
      parseStrategyConfig('v1', {
        ...minimal,
        swings: { ...minimal.swings, internal: { L: 0, R: 3 } },
      }),
    ).toThrow();
    expect(() => parseStrategyConfig('v1', [])).toThrow();
  });
  it('rejects a bias timeframe that is not analysed, and an inverted OTE band', () => {
    expect(() =>
      parseStrategyConfig('v1', {
        ...minimal,
        timeframes: { ...minimal.timeframes, bias: ['1d'] },
      }),
    ).toThrow(/bias timeframe/);
    expect(() =>
      parseStrategyConfig('v1', {
        ...minimal,
        range: { ...minimal.range, oteLow: 0.8, oteHigh: 0.6 },
      }),
    ).toThrow(/oteLow/);
  });
  it('refuses non-UTC sessions', () => {
    expect(() =>
      parseStrategyConfig('v1', {
        ...minimal,
        context: { ...minimal.context, sessionsTz: 'America/New_York' },
      }),
    ).toThrow(/UTC/);
  });
});
