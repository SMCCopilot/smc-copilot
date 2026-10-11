import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { TradeCloseSchema, TradeCreateSchema, TradePatchSchema } from '@smc/contracts';
import { z } from 'zod';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { Idempotent } from '../common/idempotency.js';
import { parseWith } from '../common/validation.js';
import { RiskService } from '../risk/risk.service.js';
import { TradesService } from './trades.service.js';

const ListQuerySchema = z.object({
  status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
const ipOf = (req: AccountRequest): string | null => req.ip?.replace(/^::ffff:/i, '') ?? null;

/** The trade log. It records what the user did; nothing here places or changes an order anywhere. */
@Controller('v1/trades')
export class TradesController {
  constructor(
    private readonly trades: TradesService,
    private readonly risk: RiskService,
  ) {}

  @UserOnly()
  @RateLimit(RATE_LIMITS.tradeWrite)
  @Idempotent()
  @Post()
  create(@Req() req: AccountRequest, @Body() body: unknown) {
    return this.trades.create(
      req.account.userId,
      req.account.workspaceId,
      parseWith(TradeCreateSchema, body),
      ipOf(req),
    );
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get()
  list(@Req() req: AccountRequest, @Query() raw: unknown) {
    const q = parseWith(ListQuerySchema, raw);
    return this.trades.list(req.account.workspaceId, q.status, q.cursor, q.limit);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get(':id')
  one(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.trades.get(id, req.account.workspaceId);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.tradeWrite)
  @Patch(':id')
  patch(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.trades.patch(
      id,
      req.account.userId,
      req.account.workspaceId,
      parseWith(TradePatchSchema, body),
    );
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.tradeWrite)
  @Post(':id/close')
  @HttpCode(200)
  async close(
    @Req() req: AccountRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const profile = await this.risk.getProfile(req.account.workspaceId);
    return this.trades.close(
      id,
      req.account.userId,
      req.account.workspaceId,
      parseWith(TradeCloseSchema, body),
      profile.takerFeeBps,
      ipOf(req),
    );
  }
}
