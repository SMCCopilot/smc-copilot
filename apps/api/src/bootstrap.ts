import * as Faultline from '@getfaultline/node';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from '@smc/config';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { generateRequestId } from './common/correlation.js';
import { requestStatsMiddleware } from './ops/request-stats.js';

/** Largest JSON body any route accepts. Explain's image arrives as multipart on its own route (A08 section 2.2). */
export const JSON_BODY_LIMIT = '64kb';

/** Everything the server needs besides its modules; shared by `main.ts` and the e2e tests so they cannot drift. */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.use(Faultline.Handlers.requestHandler());
  app.useLogger(app.get(Logger));
  // Before the body parsers, so even a rejected body carries the caller's correlation id (M1).
  app.use((req: { id?: unknown }, res: unknown, next: () => void) => {
    req.id = req.id ?? generateRequestId(req as never, res as never);
    next();
  });
  app.use(requestStatsMiddleware);
  app.use(helmet());
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: JSON_BODY_LIMIT, extended: false });
  if (env.CORS_ORIGINS.length > 0) {
    // Exact allow-list, never a wildcard (A07 section 1). Without any configured origin no CORS header is sent.
    app.enableCors({
      origin: env.CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'Idempotency-Key',
        'X-Correlation-Id',
        'If-None-Match',
        'X-Input-Mode',
      ],
      exposedHeaders: ['X-Correlation-Id', 'ETag', 'Retry-After'],
      maxAge: 600,
    });
  }
  // One trusted hop (the platform proxy): req.ip is the real client for rate limits, abuse flags and audit.
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(Faultline.Handlers.errorHandler());
  app.enableShutdownHooks();
}
