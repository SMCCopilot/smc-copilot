import { Module } from '@nestjs/common';
import { READINESS_CHECKS } from '../config/tokens.js';
import { HealthController } from './health.controller.js';
import { DbReadinessCheck, type ReadinessCheck, ReadinessService } from './readiness.js';

@Module({
  controllers: [HealthController],
  providers: [
    DbReadinessCheck,
    {
      provide: READINESS_CHECKS,
      inject: [DbReadinessCheck],
      useFactory: (db: DbReadinessCheck): ReadinessCheck[] => [db],
    },
    ReadinessService,
  ],
})
export class HealthModule {}
