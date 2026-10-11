/** Who is calling. Wallets and workspace are loaded from our own tables later; the token only proves identity. */
export interface Principal {
  readonly userId: string;
  readonly email?: string;
  readonly roles: readonly ('user' | 'admin')[];
  /** Token issue time, epoch seconds. Step-up checks compare it with "now" (A07 section 1). */
  readonly issuedAt: number;
}

export type AuthFailure = 'MISSING' | 'INVALID' | 'EXPIRED';

export class AuthError extends Error {
  constructor(readonly failure: AuthFailure) {
    super(`authentication failed: ${failure}`);
    this.name = 'AuthError';
  }
}

/**
 * Portable seam (A01 section 5.4): the rest of the product only ever sees a Principal. Supabase is one
 * implementation; another identity provider can replace it without touching handlers.
 */
export interface AuthProvider {
  /** Resolves to the principal, or throws `AuthError`. Must never return a partially verified identity. */
  verifyToken(token: string): Promise<Principal>;
}
