import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** A client-supplied id is kept only if it is short and boring; anything else is replaced (log forging, header abuse). */
export function resolveCorrelationId(supplied: string | undefined): string {
  return supplied !== undefined && SAFE_ID.test(supplied) ? supplied : randomUUID();
}

/** `genReqId` for pino-http: picks the id and echoes it on the response so the client can quote it. */
export function generateRequestId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers[CORRELATION_HEADER];
  const id = resolveCorrelationId(Array.isArray(header) ? header[0] : header);
  res.setHeader('X-Correlation-Id', id);
  return id;
}

export function correlationIdOf(req: { id?: unknown }): string {
  return typeof req.id === 'string' ? req.id : randomUUID();
}
