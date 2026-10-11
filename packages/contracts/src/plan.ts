import { z } from 'zod';
import { HistoricalStatSchema } from './facts.js';

/**
 * Trade plan, scenarios and risk (A04 section 10). Plans are data, never advice: no certainty fields, and a
 * plan without an invalidation level or an alternate scenario cannot be constructed (schema-enforced, U6).
 */
const price = z.number().finite().positive();
const id = z.string().min(1).max(64);

export const SCENARIO_KINDS = [
  'CONTINUATION', // thesis: structure continues from the point of interest
  'REVERSAL', // thesis: the sweep was a reversal
  'POI_FAILS', // alternate: the point of interest fails
  'SWEEP_NOT_REVERSAL', // alternate: the sweep was not a reversal
] as const;

export const ScenarioFactSchema = z.strictObject({
  kind: z.enum(SCENARIO_KINDS),
  /** The observable condition that says this scenario is playing out. */
  condition: z.strictObject({
    type: z.enum(['CLOSE_ABOVE', 'CLOSE_BELOW', 'TRADES_INTO']),
    level: price,
    levelId: id,
  }),
  /** Where to look next if this scenario happens (the next opposing pool), when one exists. */
  next: z.strictObject({ levelId: id, price }).nullable(),
});
export type ScenarioFact = z.infer<typeof ScenarioFactSchema>;

export const PlanTargetSchema = z.strictObject({
  id,
  price,
  levelId: id,
  rr: z.number().finite().positive(),
  label: z.enum(['TP1', 'TP2']),
});

export const TradePlanSchema = z
  .strictObject({
    planId: id,
    setupId: id,
    strategyVersionId: z.string().min(1).max(64),
    direction: z.enum(['LONG', 'SHORT']),
    entry: z.strictObject({
      type: z.literal('LIMIT_ZONE'),
      top: price,
      bottom: price,
      refPrice: price,
      refBasis: z.enum(['OB_50', 'FVG_CE', 'EDGE']),
    }),
    stop: z.strictObject({
      price,
      basis: z.string().min(1).max(32),
      bufferAtr: z.number().finite().nonnegative(),
    }),
    targets: z.array(PlanTargetSchema).min(1).max(2),
    scenarios: z.strictObject({ primary: ScenarioFactSchema, alternate: ScenarioFactSchema }),
    invalidation: z.strictObject({ level: price, rule: z.string().min(1).max(64) }),
    assumptions: z.strictObject({
      spread: z.number().finite().nonnegative(),
      slippage: z.number().finite().nonnegative(),
      feeBps: z.number().finite().nonnegative(),
      fillModel: z.literal('TOUCH_PLUS_TICK'),
    }),
    stats: HistoricalStatSchema.nullable(),
    statsReason: z.enum(['INSUFFICIENT_HISTORY']).nullable(),
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    disclaimers: z.array(z.string().max(48)).max(8),
  })
  .refine(
    (p) =>
      p.direction === 'LONG' ? p.stop.price < p.entry.refPrice : p.stop.price > p.entry.refPrice,
    {
      message: 'the stop must be on the losing side of the entry',
    },
  )
  .refine(
    (p) =>
      p.targets.every((t) =>
        p.direction === 'LONG' ? t.price > p.entry.refPrice : t.price < p.entry.refPrice,
      ),
    { message: 'targets must be on the winning side of the entry' },
  )
  .refine((p) => (p.stats === null ? p.statsReason !== null : p.statsReason === null), {
    message:
      'stats and statsReason are mutually exclusive: no stats needs a reason, stats needs none',
  })
  .refine((p) => p.entry.bottom <= p.entry.refPrice && p.entry.refPrice <= p.entry.top, {
    message: 'refPrice must lie inside the entry zone',
  });
export type TradePlan = z.infer<typeof TradePlanSchema>;

/** Hard-filter and structural reason codes (A04 section 8.3). */
export const REASON_CODES = [
  'DATA_STALE',
  'DATA_SUSPECT',
  'POI_MITIGATED',
  'WRONG_PD_SIDE',
  'STOP_TOO_TIGHT',
  'STOP_TOO_WIDE',
  'RR_TOO_LOW',
  'NO_TARGET',
  'SPREAD_WIDE',
  'VOL_EXTREME',
  'NEWS_WINDOW',
  'SETUP_EXPIRED',
  'HTF_COUNTER_BIAS',
  'NO_POI',
  'POI_INVALIDATED',
  'INVALIDATION_BREACHED',
  'TARGET_REACHED_FIRST',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const RISK_WARNINGS = [
  'RISK_ABOVE_CAP',
  'DAILY_LOSS_NEAR',
  'DAILY_LOSS_HIT',
  'OPEN_RISK_HIGH',
  'CORRELATED_EXPOSURE',
  'SIZE_UNAVAILABLE',
  'LEVERAGE_HIGH',
  'LIQUIDATION_BEFORE_STOP',
] as const;
export const RiskWarningSchema = z.enum(RISK_WARNINGS);
export type RiskWarning = z.infer<typeof RiskWarningSchema>;

export const RiskProfileSchema = z.strictObject({
  accountCurrency: z.string().min(1).max(8),
  balance: z.number().finite().positive().optional(),
  riskPerTradePct: z.number().finite().positive().max(100).default(1),
  maxRiskPerTradePct: z.number().finite().positive().max(100).default(2),
  dailyLossLimitPct: z.number().finite().positive().max(100).optional(),
  openRiskPct: z.number().finite().nonnegative().max(1000).optional(),
  maxOpenRiskPct: z.number().finite().positive().max(1000).optional(),
  contractSpec: z.strictObject({
    marketType: z.enum(['SPOT', 'PERP']),
    quantityStep: z.number().finite().positive(),
    minNotional: z.number().finite().nonnegative().optional(),
  }),
  leverage: z.number().finite().min(1).max(1000).optional(),
  takerFeeBps: z.number().finite().nonnegative().default(5),
});
export type RiskProfile = z.infer<typeof RiskProfileSchema>;

export const RiskCheckResultSchema = z.strictObject({
  ok: z.boolean(),
  positionSize: z
    .strictObject({
      units: z.number().finite().nonnegative(),
      riskAmount: z.number().finite().nonnegative(),
      notional: z.number().finite().nonnegative(),
      basis: z.literal('STOP_DISTANCE'),
    })
    .optional(),
  /** Approximate isolated-margin liquidation price (perps with a leverage entered). Verify on the venue. */
  liquidationPrice: z.number().finite().positive().optional(),
  warnings: z.array(RiskWarningSchema).max(8),
});
export type RiskCheckResult = z.infer<typeof RiskCheckResultSchema>;
