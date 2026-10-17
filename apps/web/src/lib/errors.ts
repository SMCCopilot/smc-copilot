import { ApiProblemSchema, type ErrorCode } from '@smc/contracts';

export type Recovery = 'SIGN_IN' | 'RETRY' | 'REFRESH_PLAN' | 'WAIT' | 'NONE';
export interface FriendlyError {
  message: string;
  recovery: Recovery;
}

const f = (message: string, recovery: Recovery = 'NONE'): FriendlyError => ({ message, recovery });

/** One entry per contract error code; the Record type makes a new backend code a compile error here. */
export const FRIENDLY: Record<ErrorCode, FriendlyError> = {
  AUTH_REQUIRED: f('Sign in to continue.', 'SIGN_IN'),
  TOKEN_EXPIRED: f('Your session expired. Sign in again.', 'SIGN_IN'),
  STEP_UP_REQUIRED: f('Confirm with your wallet again to continue.', 'SIGN_IN'),
  FORBIDDEN: f('You do not have access to this.'),
  ADDRESS_BLOCKED: f('This wallet cannot be used here.'),
  INVITE_REQUIRED: f('An invite code is required.'),
  DISCLAIMER_REQUIRED: f('Accept the current disclaimer to continue.'),
  AGE_CONFIRMATION_REQUIRED: f('Confirm you are 18 or older to continue.'),
  KILL_SWITCH_ACTIVE: f('This feature is switched off for now. Try again later.', 'WAIT'),
  ENTITLEMENT_REQUIRED: f('Your account does not include this feature.'),
  INSTRUMENT_NOT_ENTITLED: f('This instrument is not available to your account.'),
  FEED_LICENSE_RESTRICTED: f(
    'Raw prices are unavailable for this venue. Use your own chart and share your screen to explain.',
  ),
  WALLET_ALREADY_LINKED: f('That wallet is already linked to another account.'),
  LAST_LOGIN_METHOD: f('You cannot remove your only sign-in method.'),
  VALIDATION_FAILED: f('Some input was not valid. Check it and try again.'),
  SECRET_DETECTED: f('That looks like a seed phrase or key. It was not sent. Never share these.'),
  NOT_A_CHART: f('That image does not look like a price chart.'),
  IMAGE_TOO_LARGE: f('That image is too large.'),
  UNSUPPORTED_IMAGE: f('Use a PNG, JPEG or WebP image.'),
  NOT_FOUND: f('Not found.'),
  CONFLICT: f('That changed in the meantime. Refresh and try again.', 'RETRY'),
  IDEMPOTENCY_CONFLICT: f('That request was already used with different details.'),
  PLAN_CHANGED: f('The plan changed since you opened it. Review the updated plan.', 'REFRESH_PLAN'),
  GATE_TOKEN_INVALID: f(
    'The confirmation is no longer valid. Review the plan again.',
    'REFRESH_PLAN',
  ),
  GATE_TOKEN_EXPIRED: f(
    'The 60 second confirmation window ended. Review the plan again.',
    'REFRESH_PLAN',
  ),
  VOICE_FORBIDDEN_ACTION: f('Voice cannot confirm, log or change risk. Use the buttons.'),
  STT_UNAVAILABLE: f('Speech is unavailable. Type instead.'),
  FEED_STALE: f('The data feed is stale. Wait for it to recover.', 'WAIT'),
  ANALYSIS_UNAVAILABLE: f('Analysis is not available right now.', 'RETRY'),
  SESSION_NOT_ACTIVE: f('This session is not active.'),
  SESSION_CONTROLLER_TAKEN: f('Another tab or device is controlling this session.'),
  SESSION_LIMIT_REACHED: f('You have reached the session limit. End one first.'),
  KEY_TOO_PERMISSIVE: f('That key has more permissions than needed.'),
  INVOICE_EXPIRED: f('That invoice expired.'),
  INVOICE_NOT_PAYABLE: f('That invoice cannot be paid.'),
  RATE_LIMITED: f('Too many requests. Wait a moment.', 'WAIT'),
  DAILY_LIMIT_REACHED: f('Daily limit reached. It resets tomorrow.', 'WAIT'),
  BUDGET_EXCEEDED: f('Today’s AI budget is used up. Analysis still works.', 'WAIT'),
  AI_TEMPORARILY_UNAVAILABLE: f('AI is temporarily unavailable. Analysis still works.', 'WAIT'),
  PROVIDER_BLOCKED_BY_POLICY: f('AI is unavailable for this kind of content.'),
  PAYLOAD_TOO_LARGE: f('That is too large to send.'),
  AUTH_UNAVAILABLE: f('Sign-in is unavailable right now.', 'RETRY'),
  NOT_READY: f('The service is starting. Try again shortly.', 'RETRY'),
  INTERNAL: f('Something went wrong on our side.', 'RETRY'),
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | null,
    readonly friendly: FriendlyError,
  ) {
    super(friendly.message);
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const p = ApiProblemSchema.safeParse(body);
  if (p.success) return new ApiError(res.status, p.data.code, FRIENDLY[p.data.code]);
  return new ApiError(res.status, null, f(`Unexpected response (${res.status}).`, 'RETRY'));
}
