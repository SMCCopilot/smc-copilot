// Soft features, score and grade (A04 section 8.3). Weights are hypotheses from the strategy config, never learned.
import type { StrategyConfig } from '@smc/contracts';
import { round2 } from './ids.js';

export const FEATURE_IDS = [
  'htfAlignment',
  'sweepPresent',
  'displacementStrength',
  'fvgConfluence',
  'obFreshness',
  'killzone',
  'rrQuality',
  'zoneSize',
  'targetClarity',
  'gapBreakPenalty',
  'weekendLiquidity',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

/** Each feature is normalised to 0..1 (penalty features are 0 or 1 and carry a negative weight). */
export type FeatureValues = Record<FeatureId, number>;

/** The rule whose status gates a feature's weight (an OBSERVED rule is shown as context, weight 0). */
const RULE_OF: Partial<Record<FeatureId, string>> = {
  killzone: 'killzone',
  weekendLiquidity: 'weekend_liquidity',
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function weightOf(cfg: StrategyConfig, feature: FeatureId): number {
  const rule = RULE_OF[feature];
  if (rule && cfg.rules[rule]?.status === 'OBSERVED') return 0;
  if (feature === 'weekendLiquidity') return cfg.context.weekendLiquidityWeight;
  return cfg.scoring.weights[feature] ?? 0;
}

export interface Scored {
  score: number;
  grade: 'A' | 'B' | 'C';
  /** Points each feature contributed (weight x value). */
  contributions: Record<string, number>;
}

export function scoreSetup(values: FeatureValues, cfg: StrategyConfig): Scored {
  const contributions: Record<string, number> = {};
  let total = 0;
  for (const id of FEATURE_IDS) {
    const points = weightOf(cfg, id) * clamp01(values[id]);
    contributions[id] = round2(points);
    total += points;
  }
  const score = round2(Math.min(100, Math.max(0, total)));
  const [cut1, cut2] = cfg.scoring.gradeCuts;
  return { score, grade: score >= cut2 ? 'A' : score >= cut1 ? 'B' : 'C', contributions };
}

export const displacementFeature = (bodyAtr: number): number => clamp01(bodyAtr / 3);
export const rrFeature = (rr: number): number => clamp01(rr / 3);
/** 1 up to a zone of 1 ATR, falling linearly to 0 at 3 ATR (huge zones score lower). */
export const zoneSizeFeature = (sizeAtr: number): number => clamp01(1 - (sizeAtr - 1) / 2);
/** Distance to the first target: 1 at 6 ATR or more. */
export const targetClarityFeature = (distanceAtr: number): number => clamp01(distanceAtr / 6);
export const freshnessFeature = (status: string, touches: number): number =>
  status === 'FRESH' || status === 'OPEN' ? 1 : touches <= 1 ? 0.6 : 0.2;
