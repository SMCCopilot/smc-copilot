import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { NarrativeService } from './narrative.service.js';

@Controller('v1')
export class NarrativeController {
  constructor(private readonly narratives: NarrativeService) {}

  /**
   * The explanation of the instrument's current analysis. Always returns text: the model-written version when one
   * exists for these exact facts, otherwise the deterministic template while a fresh one is written.
   */
  @UserOnly()
  @RateLimit(RATE_LIMITS.analysis)
  @Get('instruments/:id/narrative')
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.narratives.current(id);
  }
}
