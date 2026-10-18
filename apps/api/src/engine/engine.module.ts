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
import { AnalyticsJobs } from './analytics.jobs.js';
import { EngineRunner } from './engine.runner.js';
import { EngineStore } from './engine.store.js';

@Injectable()
class EngineLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Engine');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(ENGINE_RUNNER) private readonly runner: EngineRunner | null,
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.runner) return;
    try {
      const running = await this.runner.start();
      if (running && this.sql) {
        const jobs = new AnalyticsJobs(this.sql);
        const strategy = await new EngineStore(this.sql).activeStrategy();
        if (strategy) {
          const safely = (name: string, work: () => Promise<unknown>) => () => {
            work().catch((e: unknown) =>
              this.log.warn(`${name} failed: ${(e as Error)?.constructor?.name}`),
            );
          };
          // Cohort base rates hourly, calibration daily. Both are idempotent, so a missed run is harmless.
          this.timers.push(
            setInterval(
              safely('cohort refresh', () => jobs.refreshCohorts(strategy.id)),
              3_600_000,
            ),
            setInterval(
              safely('calibration', () => jobs.calibrate(strategy.id)),
              86_400_000,
            ),
          );
          // The first interval fires an hour after start, so a server restarted more often than that would never refresh
          // them. Run once shortly after start as well (idempotent).
          this.timers.push(
            setTimeout(
              safely('cohort refresh', () => jobs.refreshCohorts(strategy.id)),
              30_000,
            ),
          );
          for (const t of this.timers) t.unref();
        }
      }
      if (running) {
        this.readiness.register({
          name: 'engine',
          run: async () => {
            if (this.runner && this.runner.failing.size > 0)
              throw new Error('engine work has failed');
          },
        });
      }
    } catch (error) {
      this.log.error(`engine failed to start: ${(error as Error)?.constructor?.name}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
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
