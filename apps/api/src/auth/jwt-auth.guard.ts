import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiProblemError } from '../common/problem.js';
import { AUTH_PROVIDER } from '../config/tokens.js';
import { AuthError, type AuthProvider, type Principal } from './auth.provider.js';

export type AuthenticatedRequest = Request & { principal: Principal };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(AUTH_PROVIDER) private readonly auth: AuthProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/.exec(header) : null;
    if (!match?.[1]) throw new ApiProblemError('AUTH_REQUIRED', 'A bearer token is required.');

    try {
      req.principal = await this.auth.verifyToken(match[1]);
      return true;
    } catch (error) {
      if (error instanceof AuthError && error.failure === 'EXPIRED') {
        throw new ApiProblemError('TOKEN_EXPIRED', 'The token has expired; sign in again.');
      }
      throw new ApiProblemError('AUTH_REQUIRED', 'The token is not valid.');
    }
  }
}
