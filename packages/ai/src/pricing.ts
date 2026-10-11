import type { LlmUsage } from './types.js';

/** USD per million tokens. */
export interface ModelPrice {
  in: number;
  out: number;
  cachedIn?: number;
}

/**
 * Prices are configuration (AI_PRICES_JSON), because vendors change them and the plan marks every figure "verify".
 * A model without a configured price is billed at this deliberately high rate, so a missing entry makes the spend
 * limits trip early instead of silently counting zero.
 */
export const FALLBACK_PRICE: ModelPrice = { in: 5, out: 25, cachedIn: 0.5 };

export class PriceTable {
  constructor(private readonly overrides: Readonly<Record<string, ModelPrice>> = {}) {}

  static parse(json: string | undefined): PriceTable {
    if (!json) return new PriceTable();
    try {
      const raw = JSON.parse(json) as Record<string, Partial<ModelPrice>>;
      const out: Record<string, ModelPrice> = {};
      for (const [model, p] of Object.entries(raw)) {
        if (typeof p?.in === 'number' && typeof p?.out === 'number' && p.in >= 0 && p.out >= 0) {
          out[model] = {
            in: p.in,
            out: p.out,
            ...(typeof p.cachedIn === 'number' ? { cachedIn: p.cachedIn } : {}),
          };
        }
      }
      return new PriceTable(out);
    } catch {
      return new PriceTable();
    }
  }

  priceOf(model: string): ModelPrice {
    return this.overrides[model] ?? FALLBACK_PRICE;
  }

  known(model: string): boolean {
    return model in this.overrides;
  }

  cost(model: string, u: LlmUsage): number {
    const p = this.priceOf(model);
    const cached = Math.min(u.cachedIn, u.tokensIn);
    const fresh = u.tokensIn - cached;
    const usd =
      (fresh * p.in +
        cached * (p.cachedIn ?? p.in) +
        u.cacheWrite * p.in * 1.25 +
        u.tokensOut * p.out) /
      1_000_000;
    return Math.round(usd * 1_000_000) / 1_000_000;
  }
}
