import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@smc/config';
import { AbuseService } from '../account/abuse.service.js';
import { RateLimiter } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { ENV } from '../config/tokens.js';

export interface AllowanceCaller {
  userId: string;
  /** Network address and browser id: used only as counter keys (hashed), never stored, never sent to a model. */
  ip: string;
  deviceId?: string | undefined;
}

/**
 * Rate limits for AI routes. The per-user limits are the ordinary ones; the per-IP and per-device limits span accounts,
 * so a scripted farm of free accounts behind one address or one browser shares a single small allowance (A08 section 2).
 */
@Injectable()
export class AiAllowanceService {
  private readonly limiter = new RateLimiter();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly abuse: AbuseService,
  ) {}

  private hit(key: string, limit: number, windowMs: number, daily: boolean): void {
    const wait = this.limiter.hit(key, limit, windowMs);
    if (wait === null) return;
    throw new ApiProblemError(
      daily ? 'DAILY_LIMIT_REACHED' : 'RATE_LIMITED',
      daily ? 'The daily AI limit has been reached.' : 'Too many requests. Try again shortly.',
      { retryAfterSec: wait },
    );
  }

  /** One AI request by this caller. `kind` keeps chat and explain on separate per-minute budgets. */
  check(c: AllowanceCaller, kind: 'chat' | 'explain', perMinute: number, perDay: number): void {
    this.hit(`${kind}:min:${c.userId}`, perMinute, 60_000, false);
    this.hit(`${kind}:day:${c.userId}`, perDay, 86_400_000, true);
    this.hit(`ip:${this.abuse.hash(c.ip)}`, this.env.AI_IP_REQUESTS_PER_DAY, 86_400_000, true);
    if (c.deviceId) {
      this.hit(
        `dev:${this.abuse.hash(c.deviceId)}`,
        this.env.AI_DEVICE_REQUESTS_PER_DAY,
        86_400_000,
        true,
      );
    }
  }
}
