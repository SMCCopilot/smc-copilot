import { z } from 'zod';
import { HistoricalStatSchema, LevelFactSchema, ZoneFactSchema } from './facts.js';
import { PlanTargetSchema, RISK_WARNINGS, ScenarioFactSchema } from './plan.js';
import { TimeframeSchema } from './timeframe.js';

/** REST DTOs for setups, analysis, sessions and risk (A07 sections 4 to 6). Zod is the source of truth. */

const iso = z.string();
const price = z.number().finite();

export const TradePlanDtoSchema = z.strictObject({
  /** The `trade_plans` row id: this is what the gate and the trade log refer to. */
  planId: z.uuid(),
  planVersion: z.number().int().positive(),
  planHash: z.string(),
  direction: z.enum(['LONG', 'SHORT']),
  entry: z.strictObject({ top: price, bottom: price, refPrice: price, basis: z.string() }),
  stop: z.strictObject({ price, basis: z.string() }),
  targets: z.array(PlanTargetSchema).min(1).max(2),
  invalidation: z.strictObject({ level: price, rule: z.string() }),
  scenarios: z.strictObject({ primary: ScenarioFactSchema, alternate: ScenarioFactSchema }),
  assumptions: z.strictObject({ spread: price, slippage: price, feeBps: price }),
  risk: z
    .strictObject({
      units: z.number().nullable(),
      riskAmount: z.number().nullable(),
      notional: z.number().nullable(),
      liquidationPrice: z.number().nullable(),
      warnings: z.array(z.enum(RISK_WARNINGS)),
    })
    .nullable(),
  warnings: z.array(z.string()),
  disclaimers: z.array(z.string()),
});
export type TradePlanDto = z.infer<typeof TradePlanDtoSchema>;

export const SETUP_STATES = [
  'CANDIDATE',
  'REJECTED',
  'ARMED',
  'TRIGGERED',
  'EXPIRED',
  'INVALIDATED',
  'RESOLVED',
] as const;

export const SetupDtoSchema = z.strictObject({
  id: z.uuid(),
  template: z.enum(['T1', 'T2', 'T3']),
  direction: z.enum(['LONG', 'SHORT']),
  instrumentId: z.uuid(),
  canonical: z.string(),
  entryTf: TimeframeSchema,
  biasTf: TimeframeSchema,
  state: z.enum(SETUP_STATES),
  grade: z.enum(['A', 'B', 'C']).nullable(),
  score: z.number().nullable(),
  reasonCodes: z.array(z.string()),
  components: z.array(z.strictObject({ kind: z.string(), id: z.string(), label: z.string() })),
  plan: TradePlanDtoSchema.nullable(),
  /** Null with `historicalReason` when the cohort has fewer than 30 resolved setups. Never a small-n number. */
  historical: HistoricalStatSchema.nullable(),
  historicalReason: z.enum(['INSUFFICIENT_HISTORY']).nullable(),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  createdAt: iso,
  updatedAt: iso,
});
export type SetupDto = z.infer<typeof SetupDtoSchema>;

export const AnalysisResponseSchema = z.strictObject({
  snapshotId: z.string(),
  /** Close time of the newest candle the engine has processed. */
  asOf: iso,
  instrumentId: z.string(),
  strategyVersionId: z.string(),
  dataQuality: z.enum(['OK', 'DEGRADED', 'STALE']),
  warnings: z.array(z.string()),
  htfBias: z.strictObject({
    tf: TimeframeSchema,
    trend: z.enum(['BULL', 'BEAR', 'RANGE']),
    lastBreak: z.strictObject({ id: z.string(), type: z.string() }).nullable(),
  }),
  structure: z
    .strictObject({
      tf: TimeframeSchema,
      trend: z.enum(['BULL', 'BEAR', 'UNDEFINED']),
      internalTrend: z.enum(['BULL', 'BEAR', 'UNDEFINED']),
      swings: z.array(
        z.strictObject({
          id: z.string(),
          kind: z.enum(['HIGH', 'LOW']),
          scale: z.enum(['internal', 'external']),
          price,
          time: iso,
        }),
      ),
      breaks: z.array(
        z.strictObject({
          id: z.string(),
          scale: z.enum(['internal', 'external']),
          type: z.string(),
          time: iso,
        }),
      ),
      range: z
        .strictObject({
          low: price,
          high: price,
          eq: price,
          oteBottom: price,
          oteTop: price,
          trend: z.enum(['BULL', 'BEAR']),
        })
        .nullable(),
    })
    .optional(),
  zones: z.array(ZoneFactSchema).optional(),
  liquidity: z.array(LevelFactSchema).optional(),
  context: z
    .strictObject({
      openLevels: z.array(LevelFactSchema),
      weekend: z.boolean(),
      session: z.string(),
      inKillzone: z.boolean(),
    })
    .optional(),
  setups: z.array(SetupDtoSchema).optional(),
  attribution: z.string().optional(),
});
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;

export const ANALYSIS_INCLUDES = [
  'structure',
  'zones',
  'liquidity',
  'context',
  'setups',
  'bias',
] as const;

// ---- sessions

export const SessionCreateSchema = z.strictObject({
  instrumentId: z.uuid().optional(),
  tf: TimeframeSchema.optional(),
  mode: z.enum(['FEED', 'APPROX']).default('FEED'),
  capture: z
    .strictObject({
      surface: z.enum(['TAB', 'WINDOW', 'SCREEN', 'NONE']),
      webgpu: z.boolean(),
    })
    .optional(),
});

export const SessionDtoSchema = z.strictObject({
  id: z.uuid(),
  instrumentId: z.uuid().nullable(),
  tf: TimeframeSchema.nullable(),
  mode: z.enum(['FEED', 'APPROX']),
  state: z.enum(['CREATED', 'ACTIVE', 'PAUSED', 'ENDED']),
  startedAt: iso,
  endedAt: iso.nullable(),
});

export const SessionCreatedSchema = z.strictObject({
  sessionId: z.uuid(),
  wsToken: z.string(),
  wsTokenExpiresAt: iso,
  wsUrl: z.string(),
  limits: z.strictObject({
    maxSessionMinutes: z.number(),
    dailyAiBudgetUsd: z.number(),
    explainPerDay: z.number(),
    voicePerDay: z.number(),
  }),
  initial: AnalysisResponseSchema.nullable(),
});

// ---- risk

export const RiskProfileDtoSchema = z.strictObject({
  accountCurrency: z.string().min(1).max(8).default('USD'),
  balance: z.number().finite().positive().max(1e12).nullable().default(null),
  riskPerTradePct: z.number().finite().positive().max(10).default(1),
  maxRiskPerTradePct: z.number().finite().positive().max(10).default(2),
  dailyLossLimitPct: z.number().finite().positive().max(100).nullable().default(null),
  weeklyLossLimitPct: z.number().finite().positive().max(100).nullable().default(null),
  maxOpenRiskPct: z.number().finite().positive().max(100).nullable().default(null),
  defaultLeverage: z.number().finite().min(1).max(1000).nullable().default(null),
  takerFeeBps: z.number().finite().nonnegative().max(1000).default(5),
});
export type RiskProfileDto = z.infer<typeof RiskProfileDtoSchema>;

export const RiskSizeBodySchema = z.strictObject({
  planId: z.uuid(),
  riskPct: z.number().finite().positive().max(10).optional(),
  leverage: z.number().finite().min(1).max(1000).optional(),
});
