import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { SessionCreateSchema } from '@smc/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { Idempotent } from '../common/idempotency.js';
import { parseWith } from '../common/validation.js';
import { SessionsService } from './sessions.service.js';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

/** `wss://host/ws` from the request, honouring a TLS-terminating proxy's forwarded protocol. */
function wsUrlOf(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? req.protocol;
  return `${proto === 'https' ? 'wss' : 'ws'}://${req.get('host') ?? 'localhost'}/ws`;
}

@Controller('v1/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @UserOnly()
  @RateLimit(RATE_LIMITS.sessionCreate)
  @Idempotent()
  @Post()
  create(@Req() req: AccountRequest, @Body() body: unknown) {
    return this.sessions.create(
      req.account.userId,
      req.account.workspaceId,
      parseWith(SessionCreateSchema, body),
      wsUrlOf(req),
    );
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get()
  list(@Req() req: AccountRequest, @Query() raw: unknown) {
    const q = parseWith(ListQuerySchema, raw);
    return this.sessions.list(req.account.userId, q.cursor, q.limit);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get(':id')
  one(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(id, req.account.userId);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Post(':id/ws-token')
  @HttpCode(200)
  token(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.refreshToken(id, req.account.userId);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Post(':id/end')
  @HttpCode(204)
  async end(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.sessions.end(id, req.account.userId);
  }
}
