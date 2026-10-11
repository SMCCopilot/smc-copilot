import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { GateConfirmSchema, GateDeclineSchema, GateIssueSchema } from '@smc/contracts';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { GateService } from './gate.service.js';

const ipOf = (req: AccountRequest): string | null => req.ip?.replace(/^::ffff:/i, '') ?? null;

/**
 * The only way to confirm anything that precedes a trade. REST only, never realtime, never voice: a request that says
 * it came from voice is refused here, and the database independently rejects any channel but UI_TAP.
 */
@Controller('v1/gate')
export class GateController {
  constructor(private readonly gate: GateService) {}

  @UserOnly()
  @RateLimit(RATE_LIMITS.gateIssue)
  @Post('issue')
  issue(@Req() req: AccountRequest, @Body() body: unknown) {
    const { planId } = parseWith(GateIssueSchema, body);
    return this.gate.issue(req.account.userId, req.account.workspaceId, planId, ipOf(req));
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.gateIssue)
  @Post(':id/confirm')
  confirm(
    @Req() req: AccountRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('x-input-mode') inputMode?: string,
  ) {
    if (inputMode && inputMode.toUpperCase() !== 'TAP') {
      throw new ApiProblemError(
        'VOICE_FORBIDDEN_ACTION',
        'A trade can only be confirmed by tapping.',
      );
    }
    const b = parseWith(GateConfirmSchema, body);
    return this.gate.confirm(
      req.account.userId,
      req.account.workspaceId,
      id,
      b.token,
      b.planHash,
      ipOf(req),
    );
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.gateIssue)
  @Post(':id/decline')
  decline(
    @Req() req: AccountRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const b = parseWith(GateDeclineSchema, body ?? {});
    return this.gate.decline(req.account.userId, req.account.workspaceId, id, b.reason, ipOf(req));
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get(':id')
  one(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.gate.get(req.account.userId, id);
  }
}
