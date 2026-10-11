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
}

/**
 * Only asymmetric algorithms: a token signed with a shared secret (legacy HS256 projects) is refused rather than
 * silently accepted. Whether the real project signs with asymmetric keys is verified in Phase 4 [verify].
 */
const ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];

export class SupabaseJwtAuthProvider implements AuthProvider {
  constructor(private readonly options: SupabaseJwtOptions) {}

  async verifyToken(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.options.getKey, {
        algorithms: ALGORITHMS,
        audience: this.options.audience,
        ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
        clockTolerance: this.options.clockToleranceSec ?? 5,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch (error) {
      // Callers learn "expired" so a client can refresh; every other reason is one opaque failure.
      throw new AuthError(error instanceof errors.JWTExpired ? 'EXPIRED' : 'INVALID');
    }

    const appMetadata = (payload.app_metadata ?? {}) as { role?: unknown };
    const email =
      typeof payload.email === 'string' && payload.email !== '' ? payload.email : undefined;
    return {
      userId: payload.sub as string,
      ...(email === undefined ? {} : { email }),
      roles: appMetadata.role === 'admin' ? ['user', 'admin'] : ['user'],
      issuedAt: payload.iat as number,
    };
  }
}

/** Used when JWT verification is not configured: every token is refused (fail closed, never open). */
export class UnconfiguredAuthProvider implements AuthProvider {
  async verifyToken(): Promise<Principal> {
    throw new AuthError('INVALID');
  }
}
