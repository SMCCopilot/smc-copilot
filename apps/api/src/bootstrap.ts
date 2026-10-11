import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from '@smc/config';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

/** Largest JSON body any route accepts. Explain's image arrives as multipart on its own route (A08 section 2.2). */
export const JSON_BODY_LIMIT = '64kb';

/** Everything the server needs besides its modules; shared by `main.ts` and the e2e tests so they cannot drift. */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
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
        'X-Turnstile-Token',
      ],
      exposedHeaders: ['X-Correlation-Id', 'ETag', 'Retry-After'],
      maxAge: 600,
    });
  }
  app.enableShutdownHooks();
}
