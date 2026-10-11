import { BlockList, isIP } from 'node:net';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Env } from '@smc/config';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ApiProblemError } from '../common/problem.js';
import { ENV } from '../config/tokens.js';

/**
 * ADMIN access class (A07 section 1): an authenticated admin role, a source address on the allow-list, and an explicit
 * confirmation header so a stray request or a browser cannot trigger an admin action by accident. Must run after
 * `JwtAuthGuard`. With no allow-list configured, production refuses every admin call (fail closed).
 * The address comes from Cloudflare's header because the API is only reachable through the tunnel.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly allow: BlockList | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.ADMIN_IP_ALLOWLIST.length === 0) {
      this.allow = null;
    } else {
      this.allow = new BlockList();
      for (const entry of env.ADMIN_IP_ALLOWLIST) {
        const [address, prefix] = entry.split('/') as [string, string | undefined];
        const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
        if (prefix === undefined) this.allow.addAddress(address, family);
        else this.allow.addSubnet(address, Number(prefix), family);
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.principal?.roles.includes('admin')) {
      throw new ApiProblemError('FORBIDDEN', 'Administrator access is required.');
    }
    if (this.allow === null) {
      if (this.env.NODE_ENV === 'production') {
        throw new ApiProblemError('FORBIDDEN', 'Administrator access is required.');
      }
    } else {
      const ip = adminSourceIp(req, this.env.TRUST_PROXY_HEADERS);
      const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
      if (isIP(ip) === 0 || !this.allow.check(ip, family)) {
        throw new ApiProblemError('FORBIDDEN', 'Administrator access is required.');
      }
    }
    if (req.headers['x-admin-confirm'] !== 'yes') {
      throw new ApiProblemError('FORBIDDEN', 'Administrator access is required.');
    }
    return true;
  }
}

/** Source address of an admin request as text, with an IPv4-mapped IPv6 prefix removed. */
export function adminSourceIp(
  req: { headers: Record<string, unknown>; ip?: string | undefined },
  trustProxyHeaders: boolean,
): string {
  // The Cloudflare header is only believed when the API is reachable solely through the tunnel.
  const header = trustProxyHeaders ? req.headers['cf-connecting-ip'] : undefined;
  const raw = typeof header === 'string' && header !== '' ? header : (req.ip ?? '');
  return raw.replace(/^::ffff:/i, '');
}
