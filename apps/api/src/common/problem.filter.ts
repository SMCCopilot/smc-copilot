import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import { correlationIdOf } from './correlation.js';
import { toProblem } from './problem.js';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { problem, unexpected, headers } = toProblem(exception, correlationIdOf(req));

    if (unexpected) {
      // The client gets INTERNAL and the correlation id; the operator gets the error through the logger.
      this.logger.error(
        { err: exception, correlationId: problem.correlationId },
        'unhandled exception',
      );
    }
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(problem.status).type('application/problem+json').send(problem);
  }
}
