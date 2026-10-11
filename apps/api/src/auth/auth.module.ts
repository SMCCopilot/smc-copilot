import { Global, Logger, Module } from '@nestjs/common';
import type { Env } from '@smc/config';
import { createRemoteJWKSet } from 'jose';
import { AUTH_PROVIDER, ENV } from '../config/tokens.js';
import type { AuthProvider } from './auth.provider.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { SupabaseJwtAuthProvider, UnconfiguredAuthProvider } from './supabase-jwt.provider.js';

@Global()
@Module({
  providers: [
    {
      provide: AUTH_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): AuthProvider => {
        if (!env.SUPABASE_JWKS_URL) {
          new Logger('Auth').warn(
            'SUPABASE_JWKS_URL is not set: every authenticated request will be refused',
          );
          return new UnconfiguredAuthProvider();
        }
        return new SupabaseJwtAuthProvider({
          getKey: createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL), { timeoutDuration: 5000 }),
          audience: env.SUPABASE_JWT_AUD,
          ...(env.SUPABASE_URL ? { issuer: `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1` } : {}),
        });
      },
    },
    JwtAuthGuard,
  ],
  exports: [AUTH_PROVIDER, JwtAuthGuard],
})
export class AuthModule {}
