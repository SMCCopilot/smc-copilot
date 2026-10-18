import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { AgeBodySchema, DisclaimerBodySchema, PatchMeSchema } from '@smc/contracts';
import { z } from 'zod';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { type AccountRequest, UserOnly, UserStar, UserStepUp } from './account.guards.js';
import { AccountService } from './account.service.js';
import { FlagsService } from './flags.service.js';

/** POST /v1/me/wallets accepts an empty body only: an address in the body would be a claim we refuse to trust. */
const NoBodySchema = z.strictObject({});

const ipOf = (req: AccountRequest): string | null => req.ip?.replace(/^::ffff:/i, '') ?? null;

@Controller('v1/me')
export class MeController {
  constructor(
    private readonly accounts: AccountService,
    private readonly flags: FlagsService,
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
  @Post('disclaimer')
  @HttpCode(204)
  async disclaimer(@Req() req: AccountRequest, @Body() body: unknown): Promise<void> {
    // The kill switch for finishing sign-up: stops new accounts from getting in during an abuse wave.
    // Only for accounts that have never accepted a disclaimer (new sign-ups); existing users re-accepting after a
    // version bump are not locked out.
    if (req.account.profile.disclaimerVersion === null && (await this.flags.killed('SIGNUP'))) {
      throw new ApiProblemError('KILL_SWITCH_ACTIVE', 'Sign-up is temporarily closed.');
    }
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
