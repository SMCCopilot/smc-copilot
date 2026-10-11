import { Global, Module } from '@nestjs/common';
import { READINESS_CHECKS } from '../config/tokens.js';
import { HealthController } from './health.controller.js';
import { DbReadinessCheck, type ReadinessCheck, ReadinessService } from './readiness.js';

@Global()
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
  exports: [ReadinessService],
})
export class HealthModule {}
