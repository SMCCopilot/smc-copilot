import { Body, Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Env, parseEnv } from '@smc/config';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { AppModule } from '../src/app.module.js';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard.js';
import { SupabaseJwtAuthProvider } from '../src/auth/supabase-jwt.provider.js';
import { configureApp } from '../src/bootstrap.js';
import { AUTH_PROVIDER } from '../src/config/tokens.js';

export const AUDIENCE = 'authenticated';
export const ISSUER = 'https://test.supabase.example/auth/v1';

@Controller('test')
class ProbeController {
  @UseGuards(JwtAuthGuard)
  @Get('protected')
  protected(): { ok: true } {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('connection to db.internal:5432 failed with password hunter2');
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

export class LogSink {
  readonly lines: string[] = [];
  write(chunk: string): void {
    this.lines.push(chunk);
  }
  get text(): string {
    return this.lines.join('');
  }
}

export interface TestKeys {
  readonly jwk: JWK;
  sign(overrides?: {
    sub?: string;
    aud?: string;
    iss?: string;
    expiresIn?: string | number;
    issuedAt?: number;
    alg?: string;
    kid?: string;
    claims?: Record<string, unknown>;
  }): Promise<string>;
}

export async function makeKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  return {
    jwk,
    async sign(o = {}) {
      const jwt = new SignJWT({ ...(o.claims ?? {}) })
        .setProtectedHeader({ alg: o.alg ?? 'ES256', kid: o.kid ?? 'k1' })
        .setSubject(o.sub ?? '11111111-1111-1111-1111-111111111111')
        .setAudience(o.aud ?? AUDIENCE)
        .setIssuer(o.iss ?? ISSUER)
        .setIssuedAt(o.issuedAt)
        .setExpirationTime(o.expiresIn ?? '5m');
      return jwt.sign(privateKey);
    },
  };
}

export interface TestAppOptions {
  readonly env?: Record<string, string>;
  readonly logSink?: LogSink;
  readonly keys?: TestKeys;
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<{ app: NestExpressApplication; env: Env }> {
  const env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info', ...options.env });
  let builder = Test.createTestingModule({
    imports: [
      AppModule.register({ env, ...(options.logSink ? { logStream: options.logSink } : {}) }),
      ProbeModule,
    ],
  });
  if (options.keys) {
    builder = builder.overrideProvider(AUTH_PROVIDER).useValue(
      new SupabaseJwtAuthProvider({
        getKey: createLocalJWKSet({ keys: [options.keys.jwk] }),
        audience: AUDIENCE,
        issuer: ISSUER,
      }),
    );
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app, env);
  await app.init();
  return { app, env };
}
