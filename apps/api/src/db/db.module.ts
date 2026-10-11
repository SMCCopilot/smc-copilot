import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Env } from '@smc/config';
import { createClient, type Sql } from '@smc/db';
import { ENV, SQL } from '../config/tokens.js';

/** Closes the pool on shutdown so SIGTERM drains cleanly (B02 section 4). */
@Injectable()
class SqlLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQL) private readonly sql: Sql | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sql?.end({ timeout: 5 });
  }
}

/** `SQL` is null when no DATABASE_URL is configured (local development without a database). */
@Global()
@Module({
  providers: [
    {
      provide: SQL,
      inject: [ENV],
      useFactory: (env: Env): Sql | null =>
        env.DATABASE_URL ? createClient(env.DATABASE_URL, { max: 10 }) : null,
    },
    SqlLifecycle,
  ],
  exports: [SQL],
})
export class DbModule {}
