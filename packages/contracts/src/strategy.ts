import { z } from 'zod';
import { TimeframeSchema } from './timeframe.js';

const pos = z.number().finite().positive();
const nonneg = z.number().finite().nonnegative();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const swingScale = z.strictObject({
  L: z.number().int().min(1).max(50),
  R: z.number().int().min(1).max(50),
});

export const RULE_STATUSES = ['OBSERVED', 'HYPOTHESIS', 'VALIDATED'] as const;

export const SessionDefSchema = z.strictObject({
  id: z.enum(['ASIA', 'LONDON', 'NY_AM', 'NY_PM']),
  tz: z.string().min(1),
  start: hhmm,
  end: hhmm,
  killzone: z.strictObject({ start: hhmm, end: hhmm }).optional(),
});
export type SessionDef = z.infer<typeof SessionDefSchema>;

/**
 * Immutable, versioned strategy configuration (A04 section 2.2). The JSON stored in
 * `strategy_versions.config` has no id; `parseStrategyConfig` adds the row id.
 *
 * Two fields are additions to the seeded v1 JSON and carry defaults so that JSON still parses:
 * `break.gapAtrMult` (GAP_BREAK threshold) and `atr.fixed` (fixtures only, never set in a shipped version).
 */
const StrategyConfigBase = z.strictObject({
  strategyVersionId: z.string().min(1),
  schemaVersion: z.literal(1),
  timeframes: z.strictObject({
    analysis: z.array(TimeframeSchema).min(1),
    bias: z.array(TimeframeSchema),
    entry: z.array(TimeframeSchema),
  }),
  swings: z.strictObject({ internal: swingScale, external: swingScale }),
  atr: z.strictObject({
    period: z.number().int().min(1).max(200),
    fixed: pos.optional(),
  }),
  break: z.strictObject({
    requireCloseBeyond: z.boolean(),
    bufferAtrMult: nonneg,
    gapAtrMult: pos.default(1),
  }),
  displacement: z.strictObject({ bodyAtrMult: pos, requireFvg: z.boolean() }),
  fvg: z.strictObject({ minSizeAtrMult: nonneg, mitigation: z.enum(['TOUCH', 'CLOSE_THROUGH']) }),
  ob: z.strictObject({
    zoneBasis: z.enum(['WICK', 'BODY']),
    requireDisplacement: z.boolean(),
    maxAgeBars: z.number().int().positive(),
  }),
  liquidity: z.strictObject({
    equalTolAtrMult: nonneg,
    sweepMinAtrMult: nonneg,
    sweepConfirmBars: z.number().int().min(1).max(20),
  }),
  range: z.strictObject({
    basis: z.literal('EXTERNAL_LEG'),
    oteLow: z.number().min(0).max(1),
    oteHigh: z.number().min(0).max(1),
  }),
  sessions: z.array(SessionDefSchema),
  context: z.strictObject({
    openLevels: z.array(TimeframeSchema.or(z.literal('1w')).or(z.literal('1M'))),
    openLevelsAsTargets: z.boolean(),
    weekendLiquidityWeight: z.number().finite(),
    sessionsTz: z.string().min(1),
  }),
  setups: z.strictObject({
    enabled: z.array(z.enum(['T1', 'T2', 'T3'])),
    expiryBars: z.partialRecord(TimeframeSchema, z.number().int().positive()),
  }),
  filters: z.strictObject({
    requireDataOk: z.boolean(),
    requirePoiFresh: z.boolean(),
    enforcePdSideT1: z.boolean(),
    enforcePdSideT2: z.boolean(),
    maxSpreadAtrMult: nonneg,
    volExtremePercentile: z.number().min(0).max(100),
    newsWindow: z.boolean(),
  }),
  scoring: z.strictObject({
    weights: z.record(z.string(), z.number().finite()),
    gradeCuts: z.tuple([z.number(), z.number()]),
  }),
  risk: z.strictObject({
    takerFeeBps: nonneg,
    minRR: pos,
    stopBufferAtrMult: nonneg,
    maxStopAtrMult: pos,
    minStopAtrMult: nonneg,
  }),
  rules: z.record(
    z.string(),
    z.strictObject({ status: z.enum(RULE_STATUSES), backtestId: z.string().optional() }),
  ),
});

/**
 * Sessions are fixed UTC windows (A04 section 9). IANA zones with DST need a time-zone table the pure engine
 * does not have, so they are refused here rather than silently treated as UTC.
 */
export const StrategyConfigSchema = StrategyConfigBase.refine(
  (c) => c.sessions.every((s) => s.tz === 'UTC') && c.context.sessionsTz === 'UTC',
  { message: 'only UTC sessions are supported (DST-aware zones are not implemented)' },
);
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export function parseStrategyConfig(strategyVersionId: string, json: unknown): StrategyConfig {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('strategy config must be a JSON object');
  }
  return StrategyConfigSchema.parse({ ...json, strategyVersionId });
}
