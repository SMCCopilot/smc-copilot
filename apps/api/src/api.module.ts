import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis/analysis.controller.js';
import { AnalysisService } from './analysis/analysis.service.js';
import { IdempotencyInterceptor } from './common/idempotency.js';
import { DevController } from './dev/dev.controller.js';
import { GateController } from './gate/gate.controller.js';
import { GateService } from './gate/gate.service.js';
import { JournalController } from './journal/journal.controller.js';
import { JournalService } from './journal/journal.service.js';
import { NotificationsService } from './journal/notifications.service.js';
import { RealtimeService } from './realtime/realtime.service.js';
import { RiskController } from './risk/risk.controller.js';
import { RiskService } from './risk/risk.service.js';
import { SessionsController } from './sessions/sessions.controller.js';
import { SessionsService } from './sessions/sessions.service.js';
import { SetupsController } from './setups/setups.controller.js';
import { SetupsService } from './setups/setups.service.js';
import { PositionMonitor } from './trades/position-monitor.js';
import { TradesController } from './trades/trades.controller.js';
import { TradesService } from './trades/trades.service.js';

/** The read APIs, risk and sessions (B05 week 10). Account guards and flags come from the global AccountModule. */
@Module({
  controllers: [
    AnalysisController,
    SetupsController,
    RiskController,
    SessionsController,
    GateController,
    TradesController,
    JournalController,
    DevController,
  ],
  providers: [
    AnalysisService,
    SetupsService,
    RiskService,
    SessionsService,
    GateService,
    TradesService,
    JournalService,
    NotificationsService,
    PositionMonitor,
    RealtimeService,
    IdempotencyInterceptor,
  ],
  exports: [
    AnalysisService,
    SetupsService,
    RiskService,
    SessionsService,
    GateService,
    TradesService,
    JournalService,
    NotificationsService,
  ],
})
export class ApiModule {}
