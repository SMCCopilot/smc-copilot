import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who an AI call is for and what it was about, carried through async calls so the `@smc/ai` package (which knows
 * nothing about users) can still be metered per workspace. None of this is ever sent to a model (invariant 8).
 */
export interface AiCallContext {
  workspaceId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  factsHash?: string | null;
  promptVersion: string;
}

const store = new AsyncLocalStorage<AiCallContext>();

export const withAiContext = <T>(ctx: AiCallContext, fn: () => Promise<T>): Promise<T> =>
  store.run(ctx, fn);
export const currentAiContext = (): AiCallContext | undefined => store.getStore();
