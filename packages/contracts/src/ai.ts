import { z } from 'zod';

/** AI-layer REST bodies and DTOs (A05, A07). Zod is the source of truth. */

export const AI_DATA_CLASSES = ['D0', 'D1', 'D2'] as const;
export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const;
export const AiProviderIdSchema = z.enum(AI_PROVIDER_IDS);

/** Owner switch for one provider. Stored in the database, so it takes effect within seconds and needs no deploy. */
export const AiProviderPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(1).max(10).optional(),
    dataClasses: z.array(z.enum(AI_DATA_CLASSES)).min(1).max(3).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

export const NarrativeScenarioSchema = z.strictObject({
  setupId: z.string(),
  kind: z.enum(['PRIMARY', 'ALTERNATE']),
  if_then: z.string(),
  invalidation_ref: z.string(),
  key_refs: z.array(z.string()),
});

export const NarrativeResponseSchema = z.strictObject({
  instrumentId: z.string(),
  asOf: z.string(),
  source: z.enum(['LLM', 'TEMPLATE']),
  /** Prose written by a model carries this label in the UI (A05 section 16, open question 4). */
  aiGenerated: z.boolean(),
  factsHash: z.string(),
  promptVersion: z.string(),
  /** A fresher explanation is being written; the one returned is the best available now. */
  generating: z.boolean(),
  content: z.strictObject({
    headline: z.string(),
    bias_summary: z.string(),
    scenarios: z.array(NarrativeScenarioSchema),
    risks_and_unknowns: z.array(z.string()),
    history: z.array(z.strictObject({ setupId: z.string(), text: z.string() })),
    refs_used: z.array(z.string()),
  }),
});
export type NarrativeResponse = z.infer<typeof NarrativeResponseSchema>;

export const ChatSendBodySchema = z.strictObject({
  sessionId: z.uuid(),
  clientMsgId: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  inputMode: z.enum(['text', 'voice']).default('text'),
  sttConfidence: z.number().min(0).max(1).optional(),
});

export const BudgetStateSchema = z.strictObject({
  spentUsd: z.number(),
  limitUsd: z.number(),
  state: z.enum(['OK', 'SOFT', 'HARD']),
  resetsAt: z.string(),
});
export type BudgetState = z.infer<typeof BudgetStateSchema>;
