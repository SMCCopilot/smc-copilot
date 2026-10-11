import type { ProviderId } from './types.js';

export type LlmErrorKind =
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'TIMEOUT'
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'NETWORK';

/** A provider call failed. Retryable kinds are tried once more, then the next provider. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return (
      this.kind === 'RATE_LIMITED' ||
      this.kind === 'SERVER' ||
      this.kind === 'TIMEOUT' ||
      this.kind === 'NETWORK'
    );
  }
}

export type UnavailableReason =
  | 'NO_PROVIDER_ENABLED'
  | 'BLOCKED_BY_POLICY'
  | 'ALL_FAILED'
  | 'NOT_CONFIGURED';

/** No model answered. Callers fall back to template text; they never show this to the user as a failure. */
export class AiUnavailableError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly attempts: readonly {
      provider: ProviderId;
      kind: LlmErrorKind | 'BREAKER_OPEN';
    }[] = [],
  ) {
    super(`AI unavailable: ${reason}`);
  }
}

/** Maps an HTTP failure to an error kind. The response body is never copied into the message (it may echo input). */
export function httpError(status: number, retryAfter: string | null): LlmError {
  const secs = retryAfter ? Number(retryAfter) : Number.NaN;
  const retryAfterMs = Number.isFinite(secs) ? Math.min(secs * 1000, 30_000) : undefined;
  if (status === 429)
    return new LlmError('RATE_LIMITED', 'provider rate limit', status, retryAfterMs);
  if (status === 401 || status === 403)
    return new LlmError('AUTH', 'provider rejected the key', status);
  if (status >= 500 || status === 408 || status === 529) {
    return new LlmError('SERVER', `provider error ${status}`, status, retryAfterMs);
  }
  return new LlmError('BAD_REQUEST', `provider refused the request (${status})`, status);
}
