import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { VoiceEventBodySchema } from '@smc/contracts';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { parseWith } from '../common/validation.js';
import { VoiceService } from './voice.service.js';

@Controller('v1/voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** Models and limits for on-device recognition. Audio never leaves the device; this says so in the contract. */
  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('config')
  async config() {
    const c = this.voice.config();
    return { ...c, glossaryVersion: (await this.voice.glossary()).version };
  }

  /** Symbols and Smart Money Concepts terms with the ways they get misheard, for correction on the device. */
  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('glossary')
  glossary() {
    return this.voice.glossary();
  }

  /** The browser reports how an utterance went: engine, timings and outcome. No audio, no transcript. */
  @UserOnly()
  @RateLimit(RATE_LIMITS.tradeWrite)
  @Post('events')
  @HttpCode(204)
  async event(@Req() req: AccountRequest, @Body() body: unknown): Promise<void> {
    const b = parseWith(VoiceEventBodySchema, body);
    await this.voice.recordEvent(
      req.account.workspaceId,
      req.account.userId,
      b.sessionId ?? null,
      b,
    );
  }
}
