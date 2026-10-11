import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import { AdminController } from '../admin/admin.controller.js';
import { AdminGuard } from '../admin/admin.guard.js';
import { ENV, EVENT_BUS, INGEST_RUNTIME, SQL } from '../config/tokens.js';
import { installDnsOverride } from '../dev/dns-override.js';
import { ReadinessService } from '../health/readiness.js';
import { LicenseGuard } from '../markets/license.guard.js';
import { MarketsController } from '../markets/markets.controller.js';
import { MarketsService } from '../markets/markets.service.js';
import { type EventBus, InMemoryEventBus } from './event-bus.js';
import { IngestRuntime } from './ingest.runtime.js';

/** Starts the live feed after the HTTP server is up (so /healthz answers while history seeds) and stops it first on shutdown. */
@Injectable()
class IngestLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Ingest');

  constructor(
    @Inject(INGEST_RUNTIME) private readonly runtime: IngestRuntime | null,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.runtime) return;
    try {
      await this.runtime.start();
      this.readiness.register({
        name: 'ingest',
        run: async () => {
          if (!this.runtime?.connected) throw new Error('a venue connection is down');
        },
      });
    } catch (error) {
      // Do not take the API down with it: /readyz reports the failure and the operator sees the log.
      this.log.error(`live ingest failed to start: ${(error as Error)?.constructor?.name}`);
      this.readiness.register({
        name: 'ingest',
        run: async () => {
          throw new Error('ingest failed to start');
        },
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime?.stop();
  }
}

@Global()
@Module({
  controllers: [MarketsController, AdminController],
  providers: [
    { provide: EVENT_BUS, useFactory: (): EventBus => new InMemoryEventBus() },
    {
      provide: INGEST_RUNTIME,
      inject: [ENV, SQL, EVENT_BUS],
      useFactory: (env: Env, sql: Sql | null, bus: EventBus): IngestRuntime | null => {
        if (!env.INGEST_ENABLED) return null;
        const log = new Logger('Ingest');
        if (!sql) {
          log.warn('INGEST_ENABLED is set but DATABASE_URL is not: live ingest stays off');
          return null;
        }
        if (env.DNS_SERVERS.length > 0) {
          installDnsOverride(env.DNS_SERVERS);
          log.warn(`DNS override active (${env.DNS_SERVERS.join(', ')}): development use only`);
        }
        return new IngestRuntime(env, sql, bus, {
          warn: (m) => log.warn(m),
          info: (m) => log.log(m),
        });
      },
    },
    MarketsService,
    LicenseGuard,
    AdminGuard,
    IngestLifecycle,
  ],
  exports: [EVENT_BUS, INGEST_RUNTIME, MarketsService],
})
export class IngestModule {}
