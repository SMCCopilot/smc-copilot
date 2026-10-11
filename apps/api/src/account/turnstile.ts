import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Env } from '@smc/config';
import { ENV } from '../config/tokens.js';

export const FETCH = Symbol('FETCH');
export type FetchFn = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile verification for the invite endpoint (A07 section 1). When the owner has opted out
 * (`TURNSTILE_DISABLED=true`) or no secret exists outside production, the check is skipped and that is logged once,
 * so it is never silently absent. With a secret configured it fails closed: a missing token or an unreachable
 * verifier means "not verified".
 */
@Injectable()
export class TurnstileVerifier {
  private readonly log = new Logger('Turnstile');
  private warned = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(FETCH) private readonly fetchImpl: FetchFn,
  ) {}

  get enforced(): boolean {
    return !this.env.TURNSTILE_DISABLED && this.env.TURNSTILE_SECRET !== undefined;
  }

  async verify(token: string | undefined, ip: string | undefined): Promise<boolean> {
    if (!this.enforced) {
      if (!this.warned) {
        this.warned = true;
        this.log.warn(
          'bot check (Turnstile) is not enforced: the invite code is the only sign-up gate',
        );
      }
      return true;
    }
    if (!token || token.length > 2048) return false;
    try {
      const body = new URLSearchParams({
        secret: this.env.TURNSTILE_SECRET as string,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }).toString();
      const res = await this.fetchImpl(VERIFY_URL, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { success?: unknown };
      return json.success === true;
    } catch {
      return false;
    }
  }
}
