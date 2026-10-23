import * as Faultline from '@getfaultline/node';
import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { correlationIdOf } from './correlation.js';
import { toProblem } from './problem.js';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // WebSocket and other contexts get their own error handling (Phase 4); never crash on them here.
    if (host.getType() !== 'http') return;
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { problem, unexpected, headers } = toProblem(exception, correlationIdOf(req));

    if (unexpected) {
      // The client gets INTERNAL and the correlation id; the operator gets the error through the logger,
      // where the `err` serializer keeps type, code and stack frames only (never message or properties).
      this.logger.error(
        { err: exception, correlationId: problem.correlationId },
        'unhandled exception',
      );
      try {
        Faultline.withScope((scope) => {
          scope.setTag('correlationId', problem.correlationId);
          Faultline.captureException(exception);
        });
      } catch {}
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(problem.status).type('application/problem+json').send(problem);
  }
}
