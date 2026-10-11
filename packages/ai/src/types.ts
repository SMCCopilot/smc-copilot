/** Jobs, data classes and the provider seam (A05 sections 2, 10 and 12). */

export const AI_JOBS = [
  'J1_IMAGE_READ',
  'J2_NARRATIVE',
  'J3_CHAT',
  'J4_REJECT_EXPLAIN',
  'J5_REVIEW',
  'J6_ROUTER',
  'J7_EXPLAIN',
  'J8_EVAL_JUDGE',
] as const;
export type JobId = (typeof AI_JOBS)[number];

/** D0: facts only. D1: a chart image. D2: user text (chat, transcripts, journal). Never wallet, email, IP or user id. */
export type DataClass = 'D0' | 'D1' | 'D2';
export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ModelTier = 'fast' | 'strong';
/** Short, structured jobs use the fast model; prose and analysis use the strong one. */
export const JOB_TIER: Record<JobId, ModelTier> = {
  J1_IMAGE_READ: 'fast',
  J2_NARRATIVE: 'strong',
  J3_CHAT: 'strong',
  J4_REJECT_EXPLAIN: 'fast',
  J5_REVIEW: 'strong',
  J6_ROUTER: 'fast',
  J7_EXPLAIN: 'strong',
  J8_EVAL_JUDGE: 'strong',
};

/** Per-attempt timeouts (A05 section 10). */
export const JOB_TIMEOUT_MS: Record<JobId, number> = {
  J1_IMAGE_READ: 8_000,
  J2_NARRATIVE: 12_000,
  J3_CHAT: 25_000,
  J4_REJECT_EXPLAIN: 8_000,
  J5_REVIEW: 600_000,
  J6_ROUTER: 4_000,
  J7_EXPLAIN: 25_000,
  J8_EVAL_JUDGE: 60_000,
};

/** An image lives in memory for the length of one request. It is never written anywhere (invariant 2). */
export interface LlmImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}
export interface LlmTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Ask the provider for JSON output where it has a mode for it. The result is validated either way. */
  json?: boolean;
  history?: readonly LlmTurn[];
  images?: readonly LlmImage[];
}
export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
  cacheWrite: number;
}
export interface ProviderCallResult {
  text: string;
  usage: LlmUsage;
}
export interface ProviderCallArgs {
  apiKey: string;
  model: string;
  req: LlmRequest;
  signal: AbortSignal;
}
export interface ProviderAdapter {
  readonly id: ProviderId;
  call(args: ProviderCallArgs): Promise<ProviderCallResult>;
}

/** What the router needs to know about one provider right now. The owner's switches arrive through this. */
export interface ProviderState {
  id: ProviderId;
  enabled: boolean;
  apiKey: string | undefined;
  /** Lower is tried first. */
  priority: number;
  dataClasses: readonly DataClass[];
  models: Partial<Record<ModelTier, string>>;
}
export interface ProviderSource {
  providers(): Promise<readonly ProviderState[]>;
}

export type CallOutcome =
  | 'OK'
  | 'SCHEMA_RETRY'
  | 'TEMPLATE_FALLBACK'
  | 'GUARDRAIL_REJECTED'
  | 'PROVIDER_BLOCKED_BY_POLICY'
  | 'ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'BUDGET_BLOCKED';

export interface CallRecord {
  id: string;
  job: JobId;
  dataClass: DataClass;
  provider: ProviderId;
  model: string;
  usage: LlmUsage;
  costUsd: number;
  latencyMs: number;
  outcome: CallOutcome;
  errorCode?: string | undefined;
}
