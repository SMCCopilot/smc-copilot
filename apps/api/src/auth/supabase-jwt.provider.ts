import { errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { AuthError, type AuthProvider, type Principal } from './auth.provider.js';

export interface SupabaseJwtOptions {
  /** Key source: a remote JWKS in production, a local key set in tests. */
  readonly getKey: JWTVerifyGetKey;
  readonly audience: string;
  /** `${SUPABASE_URL}/auth/v1`. When omitted the issuer is not checked (never in production). */
  readonly issuer?: string;
  /** Seconds of tolerated clock difference. */
  readonly clockToleranceSec?: number;
  /** Clock source in epoch seconds; tests inject one. */
  readonly now?: () => number;
}

/**
 * Only asymmetric algorithms: a token signed with a shared secret (legacy HS256 projects) is refused rather than
 * silently accepted (decision D-009). Whether the real project signs with asymmetric keys is verified in Phase 4.
 */
export const ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];

export class SupabaseJwtAuthProvider implements AuthProvider {
  constructor(private readonly options: SupabaseJwtOptions) {}

  async verifyToken(token: string): Promise<Principal> {
    const tolerance = this.options.clockToleranceSec ?? 5;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.options.getKey, {
        algorithms: ALGORITHMS,
        audience: this.options.audience,
        ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
        clockTolerance: tolerance,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      // "expired" lets a client sign in again; a key-set outage is the server's problem, not a bad token
      // (otherwise an identity-provider blip would sign every user out); everything else is one opaque failure.
      if (error instanceof errors.JWTExpired) throw new AuthError('EXPIRED');
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        throw new AuthError('UNAVAILABLE');
      }
      throw new AuthError('INVALID');
    }

    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    const claims = payload as JWTPayload & {
      role?: unknown;
      is_anonymous?: unknown;
      app_metadata?: { role?: unknown };
    };
    if (
      typeof claims.sub !== 'string' ||
      claims.sub === '' ||
      typeof claims.iat !== 'number' ||
      claims.iat > now + tolerance || // issued in the future: the step-up check relies on iat
      claims.is_anonymous === true || // anonymous sessions are never full users (A08 section 2.2)
      (claims.role !== undefined && claims.role !== 'authenticated')
    ) {
      throw new AuthError('INVALID');
    }

    const email =
      typeof claims.email === 'string' && claims.email !== '' ? claims.email : undefined;
    return {
      userId: claims.sub,
      ...(email === undefined ? {} : { email }),
      roles: claims.app_metadata?.role === 'admin' ? ['user', 'admin'] : ['user'],
      issuedAt: claims.iat,
    };
  }
}

/** Used when JWT verification is not configured: every token is refused (fail closed, never open). */
export class UnconfiguredAuthProvider implements AuthProvider {
  async verifyToken(): Promise<Principal> {
    throw new AuthError('INVALID');
  }
}
