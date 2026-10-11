import { z } from 'zod';

/** Error catalogue from A07 section 11, with the HTTP status each code maps to. */
export const ERROR_STATUS = {
  AUTH_REQUIRED: 401,
  TOKEN_EXPIRED: 401,
  STEP_UP_REQUIRED: 401,
  FORBIDDEN: 403,
  ADDRESS_BLOCKED: 403,
  INVITE_REQUIRED: 403,
  DISCLAIMER_REQUIRED: 403,
  AGE_CONFIRMATION_REQUIRED: 403,
  KILL_SWITCH_ACTIVE: 503,
  ENTITLEMENT_REQUIRED: 403,
  INSTRUMENT_NOT_ENTITLED: 403,
  FEED_LICENSE_RESTRICTED: 403,
  WALLET_ALREADY_LINKED: 409,
  LAST_LOGIN_METHOD: 409,
  VALIDATION_FAILED: 422,
  SECRET_DETECTED: 422,
  NOT_A_CHART: 422,
  IMAGE_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE: 415,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PLAN_CHANGED: 409,
  GATE_TOKEN_INVALID: 403,
  GATE_TOKEN_EXPIRED: 410,
  VOICE_FORBIDDEN_ACTION: 403,
  STT_UNAVAILABLE: 503,
  FEED_STALE: 409,
  ANALYSIS_UNAVAILABLE: 503,
  SESSION_NOT_ACTIVE: 409,
  SESSION_CONTROLLER_TAKEN: 409,
  SESSION_LIMIT_REACHED: 409,
  KEY_TOO_PERMISSIVE: 400,
  INVOICE_EXPIRED: 410,
  INVOICE_NOT_PAYABLE: 409,
  RATE_LIMITED: 429,
  DAILY_LIMIT_REACHED: 429,
  BUDGET_EXCEEDED: 402,
  AI_TEMPORARILY_UNAVAILABLE: 503,
  PROVIDER_BLOCKED_BY_POLICY: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** RFC 9457 problem details with our `code` and `correlationId` extensions (A07 section 11). */
export const ApiProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: ErrorCodeSchema,
    detail: z.string().optional(),
    correlationId: z.string(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((p) => p.status === ERROR_STATUS[p.code], {
    message: 'status does not match the catalogue status for this code',
  });
export type ApiProblem = z.infer<typeof ApiProblemSchema>;
