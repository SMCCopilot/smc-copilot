import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Env } from '@smc/config';
import { Logger, LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AuthModule } from './auth/auth.module.js';
import { buildLoggerParams } from './common/logging.js';
import { ProblemFilter } from './common/problem.filter.js';
import { ENV } from './config/tokens.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';

export interface AppModuleOptions {
  readonly env: Env;
  /** Tests capture log output through this; production logs to stdout. */
  readonly logStream?: DestinationStream;
}

@Module({})
export class AppModule {
  static register({ env, logStream }: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot(buildLoggerParams(env, logStream)),
        DbModule,
        AuthModule,
        HealthModule,
      ],
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: APP_FILTER,
          inject: [Logger],
          useFactory: (logger: Logger) => new ProblemFilter(logger),
        },
      ],
      exports: [ENV],
    };
  }
}
