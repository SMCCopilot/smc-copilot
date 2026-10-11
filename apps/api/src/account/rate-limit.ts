import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ApiProblemError } from '../common/problem.js';

/** Fixed-window counter per key. Single process at the MVP (A07 section 10); Valkey replaces the store at M6. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number; windowMs: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Consumes one unit. Returns the seconds to wait when the limit is already reached, else null. */
  hit(key: string, limit: number, windowMs: number): number | null {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      this.windows.set(key, { start: t, count: 1, windowMs });
      this.sweep(t);
      return null;
    }
    if (w.count >= limit) return Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
    w.count++;
    return null;
  }

  /** Each entry expires by its own window, so a short-window key can never clear a day-long counter. */
  private sweep(t: number): void {
    if (this.windows.size < 5000) return;
    for (const [k, w] of this.windows) if (t - w.start >= w.windowMs) this.windows.delete(k);
  }
}

export interface RateLimitSpec {
  name: string;
  limit: number;
  windowMs: number;
}

const META = 'rate-limit';
/** Default limits per A07 section 10. Per authenticated user. */
export const RATE_LIMITS = {
  read: { name: 'read', limit: 120, windowMs: 60_000 },
  sessionCreate: { name: 'session.create', limit: 10, windowMs: 3_600_000 },
  gateIssue: { name: 'gate.issue', limit: 20, windowMs: 3_600_000 },
  tradeWrite: { name: 'trade.write', limit: 60, windowMs: 3_600_000 },
  resolve: { name: 'resolve', limit: 60, windowMs: 60_000 },
  analysis: { name: 'analysis', limit: 30, windowMs: 60_000 },
  invite: { name: 'invite', limit: 10, windowMs: 3_600_000 },
} as const satisfies Record<string, RateLimitSpec>;

export const RateLimit = (spec: RateLimitSpec) => SetMetadata(META, spec);

@Injectable()
export class RateLimitGuard implements CanActivate {
  readonly limiter = new RateLimiter();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const spec = this.reflector.get<RateLimitSpec | undefined>(META, context.getHandler());
    if (!spec) return true;
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const who = req.principal?.userId ?? req.ip ?? 'anon';
    const wait = this.limiter.hit(`${spec.name}:${who}`, spec.limit, spec.windowMs);
    if (wait !== null) {
      throw new ApiProblemError('RATE_LIMITED', 'Too many requests. Try again shortly.', {
        retryAfterSec: wait,
      });
    }
    return true;
  }
}
