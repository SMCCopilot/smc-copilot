import type { MarketType, Timeframe } from '@smc/contracts';
import type { RawCandle } from './candle.js';

export type ProviderId = 'binance' | 'bybit' | 'okx' | 'coinbase' | 'kraken' | 'replay' | 'fx-stub';

export type FeedStatus =
  | 'CONNECTED'
  | 'RECONNECTED'
  | 'ROTATED'
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'RATE_LIMITED'
  | 'GEO_BLOCKED'
  | 'AUTH_ERROR';

export interface SubscriptionSpec {
  readonly venueSymbol: string;
  readonly marketType: MarketType;
  /** Base timeframe, normally 1m. */
  readonly tf: Timeframe;
}

export interface CandleSink {
  onRaw(candle: RawCandle): void;
  onStatus(status: FeedStatus, detail?: string): void;
}

export interface Subscription {
  close(): void;
}

export interface FetchRequest {
  readonly venueSymbol: string;
  readonly marketType: MarketType;
  readonly tf: Timeframe;
  /** Inclusive, epoch ms of a candle open. */
  readonly fromMs: number;
  /** Exclusive. */
  readonly toMs: number;
}

export interface VenueMarket {
  readonly venueSymbol: string;
  readonly marketType: MarketType;
  readonly tickSize: number;
  readonly lotSize: number | null;
  readonly status: string;
}

export interface ProviderHealth {
  readonly connected: boolean;
  readonly lastMessageAtMs: number | null;
  readonly reconnects: number;
}

export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly capabilities: {
    readonly streamsClosedCandles: boolean;
    readonly nativeTimeframes: readonly Timeframe[];
    readonly supportsTicks: boolean;
  };
  /** Opens one connection carrying every requested stream and reconnects on its own. */
  subscribe(specs: readonly SubscriptionSpec[], sink: CandleSink): Promise<Subscription>;
  /** Historical candles, oldest first, in pages. Used by backfill and warm-up. */
  fetchCandles(request: FetchRequest): AsyncIterable<RawCandle[]>;
  fetchMarkets(symbols: readonly string[], marketType: MarketType): Promise<VenueMarket[]>;
  health(): ProviderHealth;
}

/** HTTP 451/403 from a venue: the machine's IP range is blocked, so retrying is pointless. */
export class GeoBlockedError extends Error {
  constructor(readonly status: number) {
    super(`venue refused the request (HTTP ${status}); the IP range is probably blocked`);
    this.name = 'GeoBlockedError';
  }
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`venue rate limit hit; retry in ${retryAfterMs} ms`);
    this.name = 'RateLimitedError';
  }
}

export class NotEnabledError extends Error {
  constructor(what: string) {
    super(`${what} is not enabled`);
    this.name = 'NotEnabledError';
  }
}
