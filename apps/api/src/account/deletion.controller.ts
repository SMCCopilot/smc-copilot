import { Body, Controller, Delete, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Env } from '@smc/config';
import { DeleteMeSchema } from '@smc/contracts';
import { AdminGuard, adminSourceIp } from '../admin/admin.guard.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { parseWith } from '../common/validation.js';
import { ENV } from '../config/tokens.js';
import { type AccountRequest, UserStepUp } from './account.guards.js';
import { DeletionService } from './deletion.service.js';
import { RATE_LIMITS, RateLimit, RateLimitGuard } from './rate-limit.js';

const ipOf = (req: { ip?: string | undefined }): string | null =>
  req.ip?.replace(/^::ffff:/i, '') ?? null;

@Controller('v1/me')
export class DeletionController {
  constructor(private readonly deletion: DeletionService) {}

  /** Starts account deletion. Needs a fresh wallet signature and the exact confirmation phrase. */
  @UserStepUp()
  @RateLimit(RATE_LIMITS.invite)
  @Delete()
  async remove(@Req() req: AccountRequest, @Body() body: unknown) {
    parseWith(DeleteMeSchema, body);
    return this.deletion.request(req.account.userId, req.account.workspaceId, ipOf(req));
  }

  /**
   * Changes your mind inside the grace period. This is the one route a deleted account may still call, so it checks only
   * the sign-in, not the account state.
   */
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit(RATE_LIMITS.invite)
  @Post('deletion/cancel')
  @HttpCode(204)
  async cancel(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.deletion.cancel(req.principal.userId, ipOf(req));
  }
}

@Controller('v1/admin/deletions')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminDeletionController {
  constructor(
    private readonly deletion: DeletionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Purge every account whose grace period has ended, now. */
  @Post('run')
  async run(@Req() req: AuthenticatedRequest) {
    void adminSourceIp(req, this.env.TRUST_PROXY_HEADERS);
    return { purged: await this.deletion.purgeDue() };
  }
}
