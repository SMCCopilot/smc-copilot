import { HttpException } from '@nestjs/common';
import { type ApiProblem, ERROR_STATUS, type ErrorCode } from '@smc/contracts';

/** Throw this from any handler or guard to produce an RFC 9457 problem with a catalogue code. */
export class ApiProblemError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly extras?: Record<string, unknown>,
  ) {
    super({ code, detail }, ERROR_STATUS[code]);
  }
}

const humanize = (code: string) => {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function problemFor(
  code: ErrorCode,
  correlationId: string,
  detail?: string,
  extras?: Record<string, unknown>,
): ApiProblem {
  return {
    type: `urn:smc-copilot:error:${code.toLowerCase().replaceAll('_', '-')}`,
    title: humanize(code),
    status: ERROR_STATUS[code],
    code,
    ...(detail === undefined ? {} : { detail }),
    correlationId,
    ...(extras === undefined ? {} : { extras }),
  };
}

const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'VALIDATION_FAILED',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

export interface MappedProblem {
  readonly problem: ApiProblem;
  /** True for unexpected failures: the caller logs the original error, the client only sees INTERNAL. */
  readonly unexpected: boolean;
  /** Headers the response should carry, e.g. `Retry-After`. */
  readonly headers: Readonly<Record<string, string>>;
}

const isZodLike = (
  e: unknown,
): e is { issues: { path: unknown[]; message: string; code: string }[] } =>
  typeof e === 'object' && e !== null && Array.isArray((e as { issues?: unknown }).issues);

/** Pure mapping from any thrown value to the problem the client receives. Never includes internals. */
export function toProblem(error: unknown, correlationId: string): MappedProblem {
  if (error instanceof ApiProblemError) {
    return {
      problem: problemFor(error.code, correlationId, error.detail, error.extras),
      unexpected: false,
      headers: {},
    };
  }

  if (isZodLike(error)) {
    // Paths and rule names only: never echo the rejected values (they may be secrets or personal data).
    const issues = error.issues.map((i) => ({
      path: i.path.join('.'),
      code: i.code,
      message: i.message,
    }));
    return {
      problem: problemFor('VALIDATION_FAILED', correlationId, 'Request validation failed.', {
        issues,
      }),
      unexpected: false,
      headers: {},
    };
  }

  // body-parser errors (http-errors) and Nest's built-in HttpExceptions both expose a numeric status.
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : typeof error === 'object' && error !== null
        ? ((error as { status?: unknown; statusCode?: unknown }).status ??
          (error as { statusCode?: unknown }).statusCode)
        : undefined;

  if (typeof status === 'number' && status >= 400 && status < 500) {
    const type = (error as { type?: unknown }).type;
    const code: ErrorCode =
      type === 'entity.too.large'
        ? 'PAYLOAD_TOO_LARGE'
        : type === 'entity.parse.failed'
          ? 'VALIDATION_FAILED'
          : (STATUS_TO_CODE[status] ?? 'VALIDATION_FAILED');
    const headers: Record<string, string> = {};
    if (code === 'RATE_LIMITED') headers['Retry-After'] = '1';
    return {
      problem: problemFor(
        code,
        correlationId,
        code === 'VALIDATION_FAILED' ? 'The request could not be parsed.' : undefined,
      ),
      unexpected: false,
      headers,
    };
  }

  return { problem: problemFor('INTERNAL', correlationId), unexpected: true, headers: {} };
}
