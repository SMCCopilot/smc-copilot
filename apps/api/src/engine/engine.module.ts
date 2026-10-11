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
import { ENGINE_RUNNER, ENV, EVENT_BUS, SQL } from '../config/tokens.js';
import { ReadinessService } from '../health/readiness.js';
import { CandleStore } from '../ingest/candle-store.js';
import type { EventBus } from '../ingest/event-bus.js';
import { EngineRunner } from './engine.runner.js';

@Injectable()
class EngineLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Engine');

  constructor(
    @Inject(ENGINE_RUNNER) private readonly runner: EngineRunner | null,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.runner) return;
    try {
      const running = await this.runner.start();
      if (running) {
        this.readiness.register({
          name: 'engine',
          run: async () => {
            if (this.runner && this.runner.failures > 0) throw new Error('engine work has failed');
          },
        });
      }
    } catch (error) {
      this.log.error(`engine failed to start: ${(error as Error)?.constructor?.name}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runner?.stop();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: ENGINE_RUNNER,
      inject: [ENV, SQL, EVENT_BUS],
      useFactory: (env: Env, sql: Sql | null, bus: EventBus): EngineRunner | null => {
        if (!env.ENGINE_ENABLED || !env.INGEST_ENABLED || env.APP_ROLE === 'api' || !sql)
          return null;
        const log = new Logger('Engine');
        return new EngineRunner(sql, bus, new CandleStore(sql), {
          warn: (m) => log.warn(m),
          info: (m) => log.log(m),
        });
      },
    },
    EngineLifecycle,
  ],
  exports: [ENGINE_RUNNER],
})
export class EngineModule {}
