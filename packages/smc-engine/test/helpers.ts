import { type Candle, parseStrategyConfig, type StrategyConfig } from '@smc/contracts';
import { createEngine, type EngineEvent, step } from '../src/index.js';

export const INSTRUMENT = 'BINANCE:SPOT:BTCUSDT';

/** The `smc-core` v1 JSON seeded by migration 0009. */
export const SEED_JSON = {
  schemaVersion: 1,
  timeframes: {
    analysis: ['5m', '15m', '1h', '4h', '1d'],
    bias: ['4h', '1d'],
    entry: ['5m', '15m'],
  },
  swings: { internal: { L: 3, R: 3 }, external: { L: 10, R: 10 } },
  atr: { period: 14 },
  break: { requireCloseBeyond: true, bufferAtrMult: 0 },
  displacement: { bodyAtrMult: 1.5, requireFvg: false },
  fvg: { minSizeAtrMult: 0.1, mitigation: 'TOUCH' },
  ob: { zoneBasis: 'WICK', requireDisplacement: true, maxAgeBars: 300 },
  liquidity: { equalTolAtrMult: 0.1, sweepMinAtrMult: 0.05, sweepConfirmBars: 3 },
  range: { basis: 'EXTERNAL_LEG', oteLow: 0.62, oteHigh: 0.79 },
  sessions: [
    { id: 'ASIA', tz: 'UTC', start: '00:00', end: '08:00' },
    {
      id: 'LONDON',
      tz: 'UTC',
      start: '07:00',
      end: '16:00',
      killzone: { start: '07:00', end: '10:00' },
    },
    {
      id: 'NY_AM',
      tz: 'UTC',
      start: '12:00',
      end: '21:00',
      killzone: { start: '12:00', end: '15:00' },
    },
  ],
  context: {
    openLevels: ['1d', '1w', '1M'],
    openLevelsAsTargets: false,
    weekendLiquidityWeight: -3,
    sessionsTz: 'UTC',
  },
  setups: {
    enabled: ['T1', 'T2'],
    expiryBars: { '5m': 96, '15m': 64, '1h': 48, '4h': 30, '1d': 20 },
  },
  filters: {
    requireDataOk: true,
    requirePoiFresh: true,
    enforcePdSideT1: false,
    enforcePdSideT2: true,
    maxSpreadAtrMult: 0.2,
    volExtremePercentile: 98,
    newsWindow: false,
  },
  scoring: {
    weights: {
      htfAlignment: 20,
      sweepPresent: 15,
      displacementStrength: 15,
      fvgConfluence: 10,
      obFreshness: 10,
      killzone: 10,
      rrQuality: 10,
      zoneSize: 5,
      targetClarity: 5,
      gapBreakPenalty: -10,
    },
    gradeCuts: [50, 70],
  },
  risk: {
    takerFeeBps: 5,
    minRR: 1.5,
    stopBufferAtrMult: 0.1,
    maxStopAtrMult: 3.0,
    minStopAtrMult: 0.3,
  },
  rules: { swing_internal: { status: 'HYPOTHESIS' }, bos: { status: 'HYPOTHESIS' } },
} as const;

export function config(patch: (c: Record<string, unknown>) => void = () => {}): StrategyConfig {
  const json = JSON.parse(JSON.stringify(SEED_JSON)) as unknown as Record<string, unknown>;
  patch(json);
  return parseStrategyConfig('test-v1', json);
}

export const candle = (
  tf: Candle['tf'],
  openTime: number,
  [o, h, l, c]: readonly [number, number, number, number],
): Candle => ({
  instrumentId: INSTRUMENT,
  tf,
  openTime,
  o,
  h,
  l,
  c,
  v: 1,
  closed: true,
  providerId: 'test',
});

/** Feed rows as consecutive candles of one timeframe. */
export function run(
  rows: readonly (readonly [number, number, number, number])[],
  cfg: StrategyConfig,
  opts: { tf?: Candle['tf']; tfMs?: number; start?: number } = {},
): EngineEvent[] {
  const tf = opts.tf ?? '15m';
  const tfMs = opts.tfMs ?? 900_000;
  let state = createEngine(INSTRUMENT);
  const events: EngineEvent[] = [];
  rows.forEach((row, i) => {
    const r = step(state, candle(tf, (opts.start ?? 0) + i * tfMs, row), cfg);
    state = r.state;
    events.push(...r.events);
  });
  return events;
}
