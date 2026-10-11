import type { z } from 'zod';
import { AiUnavailableError } from './errors.js';
import { checkRefs, type RefSpace, scanNumbers } from './guard.js';
import { checkLexicon } from './lexicon.js';
import type { LlmResult, LlmRouter } from './router.js';
import { containsSecret } from './secrets.js';
import type { DataClass, JobId, LlmImage, LlmTurn, ModelTier } from './types.js';

/** Pulls the first JSON object out of a model answer, tolerating a code fence or a sentence around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** The checks every piece of model prose passes: no price literals, no banned language, no echoed secret. */
export function checkProse(texts: readonly string[]): string[] {
  const errors: string[] = [];
  for (const t of texts) {
    for (const n of scanNumbers(t)) errors.push(`contains the number "${n}" outside a placeholder`);
    for (const h of checkLexicon(t)) errors.push(`uses language that is not allowed (${h.rule})`);
    if (containsSecret(t)) errors.push('contains key-like material');
  }
  return errors;
}

export interface GuardedOptions<T> {
  router: LlmRouter;
  job: JobId;
  dataClass: DataClass;
  system: string;
  user: string;
  maxTokens: number;
  schema: z.ZodType<T>;
  texts: (o: T) => string[];
  refIds: (o: T) => string[];
  space: RefSpace;
  /** Domain rules beyond the shared ones (for example, the invalidation must be the engine's). */
  check?: (o: T) => string[];
  history?: readonly LlmTurn[];
  images?: readonly LlmImage[];
  /** Override the job's usual model tier (a soft budget uses the fast model). */
  tier?: ModelTier;
}

export type GuardedResult<T> =
  | { ok: true; out: T; calls: LlmResult[]; retried: boolean }
  | {
      ok: false;
      reason: 'UNAVAILABLE' | 'GUARDRAIL_REJECTED';
      calls: LlmResult[];
      errors: string[];
      unavailable?: AiUnavailableError;
    };

/**
 * Structured output, validated (A05 section 6.1): schema, references, number scan, language, then domain rules.
 * One repair retry that tells the model what was wrong; a second failure returns `ok: false` and the caller uses
 * the template. Calls are recorded by the router; the verdict updates their outcome.
 */
export async function runGuarded<T>(o: GuardedOptions<T>): Promise<GuardedResult<T>> {
  const calls: LlmResult[] = [];
  let user = o.user;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: LlmResult;
    try {
      r = await o.router.call(
        o.job,
        {
          system: o.system,
          user,
          maxTokens: o.maxTokens,
          json: true,
          ...(o.history ? { history: o.history } : {}),
          ...(o.images ? { images: o.images } : {}),
        },
        { dataClass: o.dataClass, ...(o.tier ? { tier: o.tier } : {}) },
      );
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        return { ok: false, reason: 'UNAVAILABLE', calls, errors: [], unavailable: e };
      }
      throw e;
    }
    calls.push(r);
    const errors: string[] = [];
    const parsed = o.schema.safeParse(extractJson(r.text));
    if (!parsed.success) {
      errors.push(
        `the JSON does not match the schema: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    } else {
      errors.push(...checkRefs(o.texts(parsed.data), o.refIds(parsed.data), o.space));
      errors.push(...checkProse(o.texts(parsed.data)));
      errors.push(...(o.check?.(parsed.data) ?? []));
    }
    if (errors.length === 0 && parsed.success) {
      return { ok: true, out: parsed.data, calls, retried: attempt > 0 };
    }
    lastErrors = errors;
    await o.router.markOutcome(r.callId, attempt === 0 ? 'SCHEMA_RETRY' : 'GUARDRAIL_REJECTED');
    user = `${o.user}\n\nYour previous answer was rejected for these reasons:\n- ${errors.slice(0, 8).join('\n- ')}\nReturn only the corrected JSON object.`;
  }
  return { ok: false, reason: 'GUARDRAIL_REJECTED', calls, errors: lastErrors };
}
