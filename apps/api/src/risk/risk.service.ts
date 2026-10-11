import { Inject, Injectable } from '@nestjs/common';
import { riskCheck } from '@smc/analytics';
import type { RiskCheckResult, RiskProfile, RiskProfileDto } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { ApiProblemError } from '../common/problem.js';
import { SQL } from '../config/tokens.js';

interface ProfileRow {
  account_currency: string;
  balance: string | null;
  risk_per_trade_pct: string;
  max_risk_per_trade_pct: string;
  daily_loss_limit_pct: string | null;
  weekly_loss_limit_pct: string | null;
  max_open_risk_pct: string | null;
  default_leverage: string | null;
  taker_fee_bps: string;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export const DEFAULT_PROFILE: RiskProfileDto = {
  accountCurrency: 'USD',
  balance: null,
  riskPerTradePct: 1,
  maxRiskPerTradePct: 2,
  dailyLossLimitPct: null,
  weeklyLossLimitPct: null,
  maxOpenRiskPct: null,
  defaultLeverage: null,
  takerFeeBps: 5,
};

export interface PlanForRisk {
  direction: 'LONG' | 'SHORT';
  refPrice: number;
  stop: number;
}
export interface InstrumentForRisk {
  marketType: 'SPOT' | 'PERP';
  lotSize: number;
  baseAsset: string;
}

/** The user's risk profile and the illustrative position-size arithmetic (A04 section 10.1). Never advice. */
@Injectable()
export class RiskService {
  constructor(@Inject(SQL) private readonly sqlOrNull: Sql | null) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  async getProfile(workspaceId: string): Promise<RiskProfileDto> {
    const [r] = await this.sql<
      ProfileRow[]
    >`select * from risk_profiles where workspace_id = ${workspaceId}`;
    if (!r) return DEFAULT_PROFILE;
    return {
      accountCurrency: r.account_currency,
      balance: num(r.balance),
      riskPerTradePct: Number(r.risk_per_trade_pct),
      maxRiskPerTradePct: Number(r.max_risk_per_trade_pct),
      dailyLossLimitPct: num(r.daily_loss_limit_pct),
      weeklyLossLimitPct: num(r.weekly_loss_limit_pct),
      maxOpenRiskPct: num(r.max_open_risk_pct),
      defaultLeverage: num(r.default_leverage),
      takerFeeBps: Number(r.taker_fee_bps),
    };
  }

  async putProfile(workspaceId: string, p: RiskProfileDto): Promise<void> {
    if (p.riskPerTradePct > p.maxRiskPerTradePct) {
      throw new ApiProblemError('VALIDATION_FAILED', 'Risk per trade cannot exceed the maximum.', {
        issues: [{ path: 'riskPerTradePct', code: 'too_big', message: 'above maxRiskPerTradePct' }],
      });
    }
    await this.sql`
      insert into risk_profiles (workspace_id, account_currency, balance, risk_per_trade_pct, max_risk_per_trade_pct,
                                 daily_loss_limit_pct, weekly_loss_limit_pct, max_open_risk_pct, default_leverage,
                                 taker_fee_bps, updated_at)
      values (${workspaceId}, ${p.accountCurrency}, ${p.balance}, ${p.riskPerTradePct}, ${p.maxRiskPerTradePct},
              ${p.dailyLossLimitPct}, ${p.weeklyLossLimitPct}, ${p.maxOpenRiskPct}, ${p.defaultLeverage},
              ${p.takerFeeBps}, now())
      on conflict (workspace_id) do update set
        account_currency = excluded.account_currency, balance = excluded.balance,
        risk_per_trade_pct = excluded.risk_per_trade_pct, max_risk_per_trade_pct = excluded.max_risk_per_trade_pct,
        daily_loss_limit_pct = excluded.daily_loss_limit_pct, weekly_loss_limit_pct = excluded.weekly_loss_limit_pct,
        max_open_risk_pct = excluded.max_open_risk_pct, default_leverage = excluded.default_leverage,
        taker_fee_bps = excluded.taker_fee_bps, updated_at = now()`;
  }

  /** Pure arithmetic from the user's own inputs. `feesQuote` is the round-trip taker fee on the notional. */
  check(
    profile: RiskProfileDto,
    plan: PlanForRisk,
    instrument: InstrumentForRisk,
    overrides: { riskPct?: number | undefined; leverage?: number | undefined } = {},
  ): RiskCheckResult & { feesQuote: number | null } {
    const leverage =
      instrument.marketType === 'PERP'
        ? (overrides.leverage ?? profile.defaultLeverage ?? undefined)
        : undefined;
    const p: RiskProfile = {
      accountCurrency: profile.accountCurrency,
      ...(profile.balance === null ? {} : { balance: profile.balance }),
      riskPerTradePct: overrides.riskPct ?? profile.riskPerTradePct,
      maxRiskPerTradePct: profile.maxRiskPerTradePct,
      ...(profile.dailyLossLimitPct === null
        ? {}
        : { dailyLossLimitPct: profile.dailyLossLimitPct }),
      ...(profile.maxOpenRiskPct === null ? {} : { maxOpenRiskPct: profile.maxOpenRiskPct }),
      contractSpec: {
        marketType: instrument.marketType,
        quantityStep: instrument.lotSize > 0 ? instrument.lotSize : 0.00000001,
      },
      ...(leverage === undefined ? {} : { leverage }),
      takerFeeBps: profile.takerFeeBps,
    };
    const result = riskCheck(
      {
        direction: plan.direction,
        entry: plan.refPrice,
        stop: plan.stop,
        baseAsset: instrument.baseAsset,
      },
      p,
    );
    const feesQuote = result.positionSize
      ? (result.positionSize.notional * 2 * profile.takerFeeBps) / 10_000
      : null;
    return { ...result, feesQuote };
  }
}
