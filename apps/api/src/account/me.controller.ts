import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  AgeBodySchema,
  DisclaimerBodySchema,
  InviteBodySchema,
  PatchMeSchema,
} from '@smc/contracts';
import { z } from 'zod';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { AbuseService } from './abuse.service.js';
import { type AccountRequest, UserOnly, UserStar, UserStepUp } from './account.guards.js';
import { AccountService } from './account.service.js';
import { FlagsService } from './flags.service.js';
import { RATE_LIMITS, RateLimit } from './rate-limit.js';
import { TurnstileVerifier } from './turnstile.js';

/** POST /v1/me/wallets accepts an empty body only: an address in the body would be a claim we refuse to trust. */
const NoBodySchema = z.strictObject({});

const ipOf = (req: AccountRequest): string | null => req.ip?.replace(/^::ffff:/i, '') ?? null;

@Controller('v1/me')
export class MeController {
  constructor(
    private readonly accounts: AccountService,
    private readonly abuse: AbuseService,
    private readonly flags: FlagsService,
    private readonly turnstile: TurnstileVerifier,
  ) {}

  /** Bootstrap: mirrors the wallet Supabase verified, runs the sanctions check, returns the whole account state. */
  @UserStar()
  @Get()
  async me(@Req() req: AccountRequest) {
    const wallets = await this.accounts.syncWallets(req.account.userId, ipOf(req));
    return this.accounts.me(req.account, wallets);
  }

  @UserStar()
  @Patch()
  @HttpCode(204)
  async patch(@Req() req: AccountRequest, @Body() body: unknown): Promise<void> {
    await this.accounts.patchMe(req.account.userId, parseWith(PatchMeSchema, body));
  }

  @UserStar()
  @RateLimit({ ...RATE_LIMITS.invite, limit: 30 })
  @Post('invite')
  @HttpCode(204)
  async invite(
    @Req() req: AccountRequest,
    @Body() body: unknown,
    @Headers('x-turnstile-token') turnstileToken?: string,
  ): Promise<void> {
    const ip = ipOf(req) ?? 'unknown';
    if (await this.flags.killed('SIGNUP')) {
      throw new ApiProblemError('KILL_SWITCH_ACTIVE', 'Sign-up is temporarily closed.');
    }
    if (await this.abuse.isBlocked('IP_HASH', ip)) {
      throw new ApiProblemError('RATE_LIMITED', 'Too many failed attempts. Try again later.');
    }
    const { code } = parseWith(InviteBodySchema, body);
    if (!(await this.turnstile.verify(turnstileToken, ip))) {
      await this.abuse.flag('IP_HASH', ip, 'TURNSTILE_FAIL', 30);
      throw new ApiProblemError('FORBIDDEN', 'The bot check failed. Try again.');
    }
    if (await this.accounts.redeemInvite(req.account.userId, code)) return;
    const blocked = await this.abuse.recordFailure('IP_HASH', ip, 'INVITE_GUESS', {
      limit: 10,
      windowMs: 3_600_000,
      blockMinutes: 60,
    });
    throw new ApiProblemError(
      blocked ? 'RATE_LIMITED' : 'INVITE_REQUIRED',
      blocked ? 'Too many failed attempts. Try again later.' : 'That invite code is not valid.',
    );
  }

  @UserStar()
  @Post('disclaimer')
  @HttpCode(204)
  async disclaimer(@Req() req: AccountRequest, @Body() body: unknown): Promise<void> {
    const { version } = parseWith(DisclaimerBodySchema, body);
    await this.accounts.acceptDisclaimer(req.account.userId, version);
    await this.accounts.audit(
      req.account.userId,
      req.account.workspaceId,
      'disclaimer.accept',
      version,
      ipOf(req),
    );
  }

  @UserStar()
  @Post('age-confirmation')
  @HttpCode(204)
  async age(@Req() req: AccountRequest, @Body() body: unknown): Promise<void> {
    parseWith(AgeBodySchema, body);
    await this.accounts.confirmAge(req.account.userId);
  }

  // ---- wallets (USER class)

  @UserOnly()
  @Get('wallets')
  async wallets(@Req() req: AccountRequest) {
    return { items: await this.accounts.walletsOf(req.account.userId) };
  }

  /** Registers the wallet the user just linked through Supabase. The body carries no address, by design. */
  @UserStepUp()
  @Post('wallets')
  async link(@Req() req: AccountRequest, @Body() body: unknown) {
    parseWith(NoBodySchema, body ?? {});
    const rows = await this.accounts.syncWallets(req.account.userId, ipOf(req));
    await this.accounts.audit(
      req.account.userId,
      req.account.workspaceId,
      'wallet.link',
      null,
      ipOf(req),
    );
    return { items: (await this.accounts.me(req.account, rows)).wallets };
  }

  @UserOnly()
  @Post('wallets/:id/primary')
  @HttpCode(204)
  async primary(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.accounts.setPrimary(req.account.userId, id);
  }

  @UserStepUp()
  @Delete('wallets/:id')
  @HttpCode(204)
  async unlink(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.accounts.unlinkWallet(req.account.userId, id, ipOf(req));
  }

  @UserOnly()
  @Get('email')
  email(@Req() req: AccountRequest) {
    return this.accounts.emailStatus(req.account.userId);
  }
}
