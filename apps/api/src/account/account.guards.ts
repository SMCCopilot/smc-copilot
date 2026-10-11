import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import type { Env } from '@smc/config';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiProblemError } from '../common/problem.js';
import { ENV } from '../config/tokens.js';
import { type AccountContext, AccountService } from './account.service.js';
import { FlagsService } from './flags.service.js';
import { RateLimitGuard } from './rate-limit.js';

export type AccountRequest = AuthenticatedRequest & { account: AccountContext };

/** Loads the caller's profile and workspace. A blocked or deleted account is refused everywhere, /v1/me included. */
@Injectable()
export class AccountGuard implements CanActivate {
  constructor(private readonly accounts: AccountService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AccountRequest>();
    const ctx = await this.accounts.loadContext(req.principal.userId);
    if (!ctx || ctx.profile.deletedAt) {
      throw new ApiProblemError('AUTH_REQUIRED', 'This account is not available.');
    }
    if (ctx.profile.blockedAt) {
      throw new ApiProblemError('ADDRESS_BLOCKED', 'This account cannot be used.');
    }
    req.account = ctx;
    return true;
  }
}

/** USER access class: invite (while the beta is closed), then disclaimer, then 18+ confirmation (A07 section 3). */
@Injectable()
export class GatesGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly flags: FlagsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { profile } = context.switchToHttp().getRequest<AccountRequest>().account;
    if (!profile.inviteRedeemedAt && !(await this.flags.isEnabled('signup.open'))) {
      throw new ApiProblemError('INVITE_REQUIRED', 'Redeem an invite code first.');
    }
    if (profile.disclaimerVersion !== this.env.DISCLAIMER_VERSION) {
      throw new ApiProblemError('DISCLAIMER_REQUIRED', 'Accept the current disclaimer first.');
    }
    if (!profile.ageConfirmedAt) {
      throw new ApiProblemError(
        'AGE_CONFIRMATION_REQUIRED',
        'Confirm that you are 18 or older first.',
      );
    }
    return true;
  }
}

/** Sensitive actions need a fresh sign-in: the token must have been issued within the last five minutes. */
@Injectable()
export class StepUpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const age = Math.floor(Date.now() / 1000) - req.principal.issuedAt;
    if (age > 300) {
      throw new ApiProblemError('STEP_UP_REQUIRED', 'Sign in again with your wallet to continue.');
    }
    return true;
  }
}

/** Authenticated, not blocked. Works before the invite, disclaimer and age gates (the `USER*` class). */
export const UserStar = () =>
  applyDecorators(UseGuards(JwtAuthGuard, AccountGuard, RateLimitGuard));
/** USER class plus a fresh sign-in (step-up). One decorator so the guard order is explicit: auth first. */
export const UserStepUp = () =>
  applyDecorators(UseGuards(JwtAuthGuard, AccountGuard, GatesGuard, StepUpGuard, RateLimitGuard));
/** The full USER class: authenticated, not blocked, and through all three gates. */
export const UserOnly = () =>
  applyDecorators(UseGuards(JwtAuthGuard, AccountGuard, GatesGuard, RateLimitGuard));
