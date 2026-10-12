import { Module } from '@nestjs/common';
import {
  AnthropicAdapter,
  type FetchLike,
  GeminiAdapter,
  LlmRouter,
  OpenAiAdapter,
  PriceTable,
} from '@smc/ai';
import type { Env } from '@smc/config';
import { AiAdminController } from './ai/ai-admin.controller.js';
import { AiAllowanceService } from './ai/ai-allowance.service.js';
import { AiGateService } from './ai/ai-gate.service.js';
import { AiMeterService } from './ai/ai-meter.service.js';
import { ChatController } from './ai/chat.controller.js';
import { ChatService } from './ai/chat.service.js';
import { ExplainController } from './ai/explain.controller.js';
import { ExplainService } from './ai/explain.service.js';
import { NarrativeController } from './ai/narrative.controller.js';
import { NarrativeService } from './ai/narrative.service.js';
import { ProviderConfigService } from './ai/provider-config.service.js';
import { AnalysisController } from './analysis/analysis.controller.js';
import { AnalysisService } from './analysis/analysis.service.js';
import { IdempotencyInterceptor } from './common/idempotency.js';
import { ENV, LLM_ROUTER } from './config/tokens.js';
import { ContextService } from './context/context.service.js';
import { DevController } from './dev/dev.controller.js';
import { GateController } from './gate/gate.controller.js';
import { GateService } from './gate/gate.service.js';
import { JournalController } from './journal/journal.controller.js';
import { JournalService } from './journal/journal.service.js';
import { NotificationsService } from './journal/notifications.service.js';
import { MetricsController } from './ops/metrics.controller.js';
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
import { VoiceController } from './voice/voice.controller.js';
import { VoiceService } from './voice/voice.service.js';

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
    NarrativeController,
    AiAdminController,
    ChatController,
    ExplainController,
    VoiceController,
    MetricsController,
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
    ProviderConfigService,
    AiMeterService,
    AiGateService,
    AiAllowanceService,
    NarrativeService,
    ChatService,
    ContextService,
    ExplainService,
    VoiceService,
    {
      provide: LLM_ROUTER,
      inject: [ENV, ProviderConfigService, AiMeterService],
      useFactory: (env: Env, source: ProviderConfigService, meter: AiMeterService): LlmRouter => {
        const f = ((url, init) => fetch(url, init)) as FetchLike;
        return new LlmRouter({
          source,
          adapters: {
            anthropic: new AnthropicAdapter(f),
            openai: new OpenAiAdapter(f),
            gemini: new GeminiAdapter(f),
          },
          prices: PriceTable.parse(env.AI_PRICES_JSON),
          onCall: meter.onCall,
          onOutcome: meter.onOutcome,
        });
      },
    },
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
    NarrativeService,
    AiGateService,
    ProviderConfigService,
    LLM_ROUTER,
  ],
})
export class ApiModule {}
