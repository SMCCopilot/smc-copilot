import { Global, Module } from '@nestjs/common';
import { AbuseService } from './abuse.service.js';
import { AccountGuard, GatesGuard, StepUpGuard } from './account.guards.js';
import { AccountService } from './account.service.js';
import { AdminOpsController } from './admin-ops.controller.js';
import { AdminOpsService } from './admin-ops.service.js';
import { AdminDeletionController, DeletionController } from './deletion.controller.js';
import { DeletionService } from './deletion.service.js';
import { FlagsService } from './flags.service.js';
import { MeController } from './me.controller.js';
import { RateLimitGuard } from './rate-limit.js';
import { FETCH, type FetchFn, TurnstileVerifier } from './turnstile.js';

/** Identity, gates, abuse controls and operator actions (B05 week 9). Global so every feature module can use its guards. */
@Global()
@Module({
  controllers: [MeController, AdminOpsController, DeletionController, AdminDeletionController],
  providers: [
    { provide: FETCH, useValue: ((url, init) => fetch(url, init)) as FetchFn },
    FlagsService,
    AbuseService,
    TurnstileVerifier,
    AccountService,
    AdminOpsService,
    DeletionService,
    AccountGuard,
    GatesGuard,
    StepUpGuard,
    RateLimitGuard,
  ],
  exports: [
    FlagsService,
    AbuseService,
    AccountService,
    AccountGuard,
    GatesGuard,
    StepUpGuard,
    RateLimitGuard,
  ],
})
export class AccountModule {}
