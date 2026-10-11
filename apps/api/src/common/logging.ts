import type { Env } from '@smc/config';
import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { generateRequestId } from './correlation.js';

/**
 * Keys that must never reach a log line (invariant 2 and 10; A08 section 2.2): credentials, personal data and any
 * media buffer. Request and response objects are also reduced to a safe subset by the serializers below.
 */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'signature',
  'apiKey',
  'email',
  'address',
  'image',
  'frame',
  'audio',
  'bytes',
  'buffer',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.signature',
  '*.apiKey',
  '*.email',
  '*.address',
  '*.image',
  '*.frame',
  '*.audio',
  '*.bytes',
  '*.buffer',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

/** Health probes are noisy; everything else is logged once per request. */
const QUIET_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Errors are reduced to type, string code and stack frames. The message and every other property are dropped:
 * they routinely embed connection strings, database row detail or request headers (H1 in the step 3 review).
 */
export function safeErr(err: unknown): { type: string; code?: string; stack?: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    constructor?: { name?: string };
    code?: unknown;
    stack?: unknown;
    message?: unknown;
  };
  // Drop everything before the first real frame: the header is `Name: message`, and a multi-line message could
  // otherwise contain a line that looks like a frame.
  const lines = typeof e.stack === 'string' ? e.stack.split(/\r?\n/) : [];
  const firstFrame = lines.findIndex((l) => /^\s+at /.test(l));
  const frames =
    firstFrame >= 0
      ? lines
          .slice(firstFrame)
          .filter((l) => /^\s+at /.test(l))
          .slice(0, 12)
          .join('\n')
      : undefined;
  return {
    type: e.constructor?.name ?? typeof err,
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(frames ? { stack: frames } : {}),
  };
}

const pathOnly = (url: string | undefined) => (url ?? '').split('?')[0] ?? '';

export function buildLoggerParams(env: Pick<Env, 'LOG_LEVEL'>, stream?: DestinationStream): Params {
  const options = {
    level: env.LOG_LEVEL,
    genReqId: generateRequestId,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    autoLogging: { ignore: (req: { url?: string }) => QUIET_PATHS.has(pathOnly(req.url)) },
    // No headers, no query string, no body: only what is needed to follow a request through the system.
    serializers: {
      req: (req: { id?: string; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        path: pathOnly(req.url),
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: safeErr,
    },
    customProps: (req: { id?: unknown }) => ({ correlationId: req.id }),
  };
  return { pinoHttp: stream ? [options, stream] : options };
}
