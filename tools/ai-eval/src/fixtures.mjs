// Frozen evaluation fixtures (A05 section 14.5): a deterministic set of MarketFacts, including the edge cases that
// matter for safety: stale data, no bias, no setups, no statistic, a statistic, several setups, both directions.
import { MarketFactsSchema } from '@smc/contracts';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSTRUMENTS = [
  ['BINANCE:PERP:BTCUSDT', 64000, 0.5],
  ['BINANCE:SPOT:ETHUSDT', 3200, 0.05],
  ['BYBIT:PERP:SOLUSDT', 180, 0.01],
  ['BINANCE:PERP:ETHUSDT', 3200, 0.05],
];
const LEVEL_KINDS = [
  'EQH',
  'EQL',
  'PDH',
  'PDL',
  'PWH',
  'PWL',
  'SWING_HIGH',
  'SWING_LOW',
  'OPEN_DAY',
];
const BIAS_TFS = ['4h', '1d'];
const BREAKS = ['BOS_UP', 'BOS_DOWN', 'CHOCH_UP', 'CHOCH_DOWN'];
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** The k-th fixture. Cases 0 to 9 are fixed edge cases; the rest are randomised from the seed. */
export function makeFacts(k, seed = 20261012) {
  const rng = mulberry32(seed + k * 7919);
  const [instrumentId, base, tick] = pick(rng, INSTRUMENTS);
  const price = (off) => Math.round((base + off * base * 0.002) / tick) * tick;
  const nLevels = k === 3 ? 0 : 3 + Math.floor(rng() * 9);
  const levels = Array.from({ length: nLevels }, (_, i) => ({
    id: `L${i + 1}`,
    label: `${pick(rng, ['Asian', 'London', 'Previous day', 'Weekly', 'Equal'])} level ${i + 1}`,
    kind: pick(rng, LEVEL_KINDS),
    price: price((rng() - 0.5) * 20),
  }));
  const nZones = k === 3 ? 0 : 1 + Math.floor(rng() * 4);
  const zones = Array.from({ length: nZones }, (_, i) => {
    const mid = price((rng() - 0.5) * 16);
    return {
      id: `Z${i + 1}`,
      label: `${pick(rng, ['Bullish', 'Bearish'])} order block ${i + 1}`,
      top: mid + tick * 20,
      bottom: mid - tick * 20,
      state: pick(rng, ['FRESH', 'TESTED', 'FILLED']),
    };
  });
  const nSetups = k === 3 || k === 4 ? 0 : k === 5 ? 3 : Math.floor(rng() * 3);
  const setups = Array.from({ length: nSetups }, (_, i) => {
    const inv = {
      id: `L${100 + i}`,
      label: `Invalidation ${i + 1}`,
      kind: 'INVALIDATION',
      price: price(-8 - i),
    };
    const tgt = {
      id: `L${200 + i}`,
      label: `Target ${i + 1}`,
      kind: 'TARGET',
      price: price(8 + i),
    };
    levels.push(inv, tgt);
    const zone = zones[i % Math.max(1, zones.length)];
    const hasStats = k % 5 === 0 || (k > 9 && rng() < 0.3);
    return {
      id: `S${i + 1}`,
      template: pick(rng, ['T1', 'T2']),
      direction: pick(rng, ['LONG', 'SHORT']),
      grade: pick(rng, ['A', 'B', 'C', null]),
      state: pick(rng, ['ARMED', 'TRIGGERED']),
      reasonCodes: [],
      poi: zone ? zone.id : 'Z1',
      invalidation: inv.id,
      targets: [tgt.id],
      stats: hasStats
        ? {
            n: 30 + Math.floor(rng() * 200),
            rate: Math.round((0.25 + rng() * 0.3) * 100) / 100,
            ci95: [0.2, 0.6],
            source: pick(rng, ['BACKTEST', 'LIVE_SHADOW']),
            window: { from: '2025-10', to: '2026-10' },
            disclaimerKey: 'HISTORICAL_NOT_FORECAST',
          }
        : null,
    };
  });
  if (setups.length > 0 && zones.length === 0)
    zones.push({
      id: 'Z1',
      label: 'Point of interest',
      top: price(1),
      bottom: price(-1),
      state: 'POI',
    });
  const quality =
    k === 1 ? 'STALE' : k === 2 ? 'DEGRADED' : k > 9 && rng() < 0.1 ? 'DEGRADED' : 'OK';
  const facts = {
    asOf: Date.UTC(2026, 9, 12, 8, 0, 0) + k * 900_000,
    instrumentId,
    strategyVersionId: 'eval-sv',
    dataQuality: quality,
    htfBias: {
      tf: pick(rng, BIAS_TFS),
      trend: k === 6 ? 'RANGE' : pick(rng, ['BULL', 'BEAR', 'RANGE']),
      lastBreak: k === 7 ? null : { id: 'E1', type: pick(rng, BREAKS) },
    },
    levels,
    zones,
    setups,
    warnings: quality !== 'OK' ? ['FEED_STALE'] : k === 8 ? ['NO_HTF_BIAS', 'ATR_NOT_READY'] : [],
  };
  return MarketFactsSchema.parse(facts);
}

export const makeFixtures = (n = 100, seed = 20261012) =>
  Array.from({ length: n }, (_, k) => makeFacts(k, seed));
