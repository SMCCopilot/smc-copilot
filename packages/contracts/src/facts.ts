import { z } from 'zod';
import { CanonicalInstrumentSchema } from './instrument.js';
import { TimeframeSchema } from './timeframe.js';

/**
 * v0 of the only market view the AI may see (A01 section 7, A05 section 4.2). Every price the narrative may
 * mention has an id; prices appear for reference and the model writes `{{L:<id>}}` placeholders instead.
 * The engine owns the full shape in Phase 2; changes stay additive. Everything is strict and bounded: this
 * object is built from engine output only (invariant 4) and nothing else can ride along into a prompt.
 */
const id = z.string().min(1).max(32);
const label = z.string().max(160);
const num = z.number().finite();

export const LevelFactSchema = z.strictObject({ id, label, kind: z.string().max(32), price: num });

export const ZoneFactSchema = z.strictObject({
  id,
  label,
  top: num,
  bottom: num,
  state: z.string().max(32),
});

/**
 * Base-rate statistics (invariant 5): the contract itself refuses n < 30, so a probability can only exist
 * in the object when the cohort is sufficient. Insufficient history is `null`, never a small-n number.
 */
export const HistoricalStatSchema = z.strictObject({
  n: z.number().int().min(30),
  rate: z.number().min(0).max(1),
  ci95: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
  source: z.enum(['LIVE_SHADOW', 'BACKTEST']),
  window: z.strictObject({ from: z.string().max(40), to: z.string().max(40) }),
  disclaimerKey: z.literal('HISTORICAL_NOT_FORECAST'),
});
export type HistoricalStat = z.infer<typeof HistoricalStatSchema>;

export const SetupFactSchema = z.strictObject({
  id,
  template: z.enum(['T1', 'T2', 'T3']),
  direction: z.enum(['LONG', 'SHORT']),
  grade: z.enum(['A', 'B', 'C']).nullable(),
  state: z.string().max(32),
  reasonCodes: z.array(z.string().max(48)).max(32),
  poi: id,
  invalidation: id,
  targets: z.array(id).max(8),
  stats: HistoricalStatSchema.nullable(),
});

export const MarketFactsSchema = z.strictObject({
  asOf: z.number().int().nonnegative(),
  instrumentId: CanonicalInstrumentSchema,
  strategyVersionId: z.string().min(1).max(64),
  dataQuality: z.enum(['OK', 'DEGRADED', 'STALE']),
  htfBias: z.strictObject({
    tf: TimeframeSchema,
    trend: z.enum(['BULL', 'BEAR', 'RANGE']),
    lastBreak: z.strictObject({ id, type: z.string().max(32) }).nullable(),
  }),
  levels: z.array(LevelFactSchema).max(400),
  zones: z.array(ZoneFactSchema).max(400),
  setups: z.array(SetupFactSchema).max(50),
  warnings: z.array(z.string().max(48)).max(50),
});
export type MarketFacts = z.infer<typeof MarketFactsSchema>;
