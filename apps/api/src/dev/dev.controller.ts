import { Controller, Get, Header, Inject, NotFoundException, Res } from '@nestjs/common';
import type { Env } from '@smc/config';
import type { Response } from 'express';
import { ENV } from '../config/tokens.js';
import { DEV_CLIENT_HTML } from './dev-client.js';

/** The developer client. Absent (404) unless DEV_CLIENT_ENABLED=true; it carries no secrets, only the public Supabase keys. */
@Controller('dev')
export class DevController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  private ensure(): void {
    if (!this.env.DEV_CLIENT_ENABLED) throw new NotFoundException();
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  page(@Res() res: Response): void {
    this.ensure();
    const supabase = this.env.SUPABASE_URL ? new URL(this.env.SUPABASE_URL).origin : '';
    // Narrow, page-specific policy: the global helmet default blocks inline script and the two CDN libraries this page uses.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline'",
        `connect-src 'self' ws: wss: ${supabase}`,
        "img-src 'self' data:",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    res.type('html').send(DEV_CLIENT_HTML);
  }

  @Get('config')
  @Header('Cache-Control', 'no-store')
  config(): { supabaseUrl: string; anonKey: string } {
    this.ensure();
    return { supabaseUrl: this.env.SUPABASE_URL ?? '', anonKey: this.env.SUPABASE_ANON_KEY ?? '' };
  }
}
