import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req } from '@nestjs/common';
import { RiskProfileDtoSchema, RiskSizeBodySchema, type TradePlan } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { SQL } from '../config/tokens.js';
import { RiskService } from './risk.service.js';

@Controller('v1')
export class RiskController {
  constructor(
    private readonly risk: RiskService,
    @Inject(SQL) private readonly sql: Sql | null,
  ) {}

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('risk-profile')
  profile(@Req() req: AccountRequest) {
    return this.risk.getProfile(req.account.workspaceId);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Put('risk-profile')
  @HttpCode(200)
  async put(@Req() req: AccountRequest, @Body() body: unknown) {
    const dto = parseWith(RiskProfileDtoSchema, body);
    await this.risk.putProfile(req.account.workspaceId, dto);
    return this.risk.getProfile(req.account.workspaceId);
  }

  /** Illustrative arithmetic from the user's own inputs: "at 1% risk and this stop, size would be X". Not advice. */
  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Post('risk/size')
  @HttpCode(200)
  async size(@Req() req: AccountRequest, @Body() body: unknown) {
    const { planId, riskPct, leverage } = parseWith(RiskSizeBodySchema, body);
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    const [row] = await this.sql<
      { plan: TradePlan; market_type: 'SPOT' | 'PERP'; lot_size: string; base: string }[]
    >`
      select p.plan, i.market_type, i.lot_size, i.base
        from trade_plans p join setups s on s.id = p.setup_id join instruments i on i.id = s.instrument_id
       where p.id = ${planId}`;
    if (!row) throw new ApiProblemError('NOT_FOUND');
    const profile = await this.risk.getProfile(req.account.workspaceId);
    const c = this.risk.check(
      profile,
      {
        direction: row.plan.direction,
        refPrice: row.plan.entry.refPrice,
        stop: row.plan.stop.price,
      },
      { marketType: row.market_type, lotSize: Number(row.lot_size), baseAsset: row.base },
      { riskPct, leverage },
    );
    return {
      units: c.positionSize?.units ?? null,
      riskAmount: c.positionSize?.riskAmount ?? null,
      notional: c.positionSize?.notional ?? null,
      feesQuote: c.feesQuote,
      liquidationPrice: c.liquidationPrice ?? null,
      warnings: c.warnings,
      disclaimerKey: 'ILLUSTRATIVE_ARITHMETIC_NOT_ADVICE',
    };
  }
}
