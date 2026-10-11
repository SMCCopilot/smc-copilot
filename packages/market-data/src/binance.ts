import { type MarketType, TIMEFRAME_MS } from '@smc/contracts';
import type { RawCandle } from './candle.js';
import { parseBinanceFrame } from './frames.js';
import { defaultFetch, type FetchLike, getJson, TokenBucket } from './http.js';
import {
  defaultSocketFactory,
  ManagedConnection,
  realScheduler,
  type Scheduler,
  type SocketFactory,
} from './managed-connection.js';
import {
  type CandleSink,
  type FeedStatus,
  type FetchRequest,
  GeoBlockedError,
  type MarketDataProvider,
  type ProviderHealth,
  RateLimitedError,
  type Subscription,
  type SubscriptionSpec,
  type VenueMarket,
} from './provider.js';

export interface BinanceOptions {
  /** `wss://data-stream.binance.vision` (spot) and `wss://fstream.binance.com/market` (perp); `/stream?streams=` is appended. */
  readonly wsUrl: Record<MarketType, string>;
  readonly restUrl: Record<MarketType, string>;
  readonly fetchImpl?: FetchLike;
  readonly socketFactory?: SocketFactory;
  readonly scheduler?: Scheduler;
}

const PAGE = 1000;
/** Binance closes a connection after 24 h; replace it ten minutes early (A03 section 3). */
const ROTATE_AFTER_MS = 23 * 3_600_000 + 50 * 60_000;
const KLINES: Record<MarketType, string> = { SPOT: '/api/v3/klines', PERP: '/fapi/v1/klines' };
const PING: Record<MarketType, string> = { SPOT: '/api/v3/ping', PERP: '/fapi/v1/ping' };
const EXCHANGE_INFO: Record<MarketType, string> = {
  SPOT: '/api/v3/exchangeInfo',
  PERP: '/fapi/v1/exchangeInfo',
};

export class BinanceProvider implements MarketDataProvider {
  readonly id = 'binance' as const;
  readonly capabilities = {
    streamsClosedCandles: true,
    nativeTimeframes: ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const,
    supportsTicks: false,
  };

  private readonly fetchImpl: FetchLike;
  private readonly socketFactory: SocketFactory;
  private readonly clock: Scheduler;
  private readonly limiter: TokenBucket;
  private readonly connections = new Set<ManagedConnection>();

  constructor(private readonly options: BinanceOptions) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.clock = options.scheduler ?? realScheduler;
    // Spot REST allows about 6000 weight per minute per IP; klines cost 2. Stay at half of it (A03 section 8.2).
    this.limiter = new TokenBucket(
      3000,
      50,
      () => this.clock.now(),
      (ms) => new Promise((resolve) => this.clock.setTimeout(resolve, ms)),
    );
  }

  async subscribe(specs: readonly SubscriptionSpec[], sink: CandleSink): Promise<Subscription> {
    const opened: ManagedConnection[] = [];
    for (const marketType of ['SPOT', 'PERP'] as const) {
      const symbols = specs.filter((s) => s.marketType === marketType && s.tf === '1m');
      if (symbols.length === 0) continue;
      const streams = symbols
        .map((s) => `${encodeURIComponent(s.venueSymbol.toLowerCase())}@kline_1m`)
        .join('/');
      const conn = new ManagedConnection({
        url: `${this.options.wsUrl[marketType]}/stream?streams=${streams}`,
        factory: this.socketFactory,
        scheduler: this.clock,
        onMessage: (text, at) => {
          for (const candle of parseBinanceFrame(text, marketType, at)) sink.onRaw(candle);
        },
        onStatus: (status, detail) => sink.onStatus(status, detail),
        rotateAfterMs: ROTATE_AFTER_MS,
        silenceTimeoutMs: 60_000,
        classifyFailure: () => this.classify(marketType),
      });
      this.connections.add(conn);
      opened.push(conn);
      conn.start();
    }
    return {
      close: () => {
        for (const c of opened) {
          c.close();
          this.connections.delete(c);
        }
      },
    };
  }

  /** A REST probe tells a blocked IP range (HTTP 451/403) from an ordinary outage. */
  private async classify(marketType: MarketType): Promise<FeedStatus | null> {
    try {
      await getJson(`${this.options.restUrl[marketType]}${PING[marketType]}`, {
        fetchImpl: this.fetchImpl,
        timeoutMs: 5000,
      });
      return null;
    } catch (error) {
      if (error instanceof GeoBlockedError) return 'GEO_BLOCKED';
      if (error instanceof RateLimitedError) return 'RATE_LIMITED';
      return null;
    }
  }

  async *fetchCandles(request: FetchRequest): AsyncIterable<RawCandle[]> {
    const tfMs = TIMEFRAME_MS[request.tf];
    let from = request.fromMs;
    while (from < request.toMs) {
      const url =
        `${this.options.restUrl[request.marketType]}${KLINES[request.marketType]}` +
        `?symbol=${encodeURIComponent(request.venueSymbol)}&interval=${request.tf}&startTime=${from}` +
        `&endTime=${request.toMs - 1}&limit=${PAGE}`;
      const rows = await getJson(url, {
        fetchImpl: this.fetchImpl,
        limiter: this.limiter,
        weight: 2,
      });
      if (!Array.isArray(rows) || rows.length === 0) return;
      const now = this.clock.now();
      const page: RawCandle[] = [];
      for (const row of rows as unknown[][]) {
        const openTimeMs = row[0];
        if (typeof openTimeMs !== 'number') continue;
        page.push({
          venueSymbol: request.venueSymbol,
          marketType: request.marketType,
          tf: request.tf,
          openTimeMs,
          o: String(row[1]),
          h: String(row[2]),
          l: String(row[3]),
          c: String(row[4]),
          v: String(row[5]),
          closed: now >= openTimeMs + tfMs,
          receivedAtMs: now,
        });
      }
      if (page.length === 0) return;
      yield page;
      const last = page[page.length - 1]?.openTimeMs ?? from;
      if (last < from || rows.length < PAGE) return;
      from = last + tfMs;
    }
  }

  async fetchMarkets(symbols: readonly string[], marketType: MarketType): Promise<VenueMarket[]> {
    const wanted = new Set(symbols);
    const body = (await getJson(`${this.options.restUrl[marketType]}${EXCHANGE_INFO[marketType]}`, {
      fetchImpl: this.fetchImpl,
      limiter: this.limiter,
      weight: 20,
    })) as { symbols?: { symbol: string; status: string; filters?: Record<string, string>[] }[] };
    const out: VenueMarket[] = [];
    for (const s of body.symbols ?? []) {
      if (!wanted.has(s.symbol)) continue;
      const tick = Number(s.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize);
      const step = Number(s.filters?.find((f) => f.filterType === 'LOT_SIZE')?.stepSize);
      if (!Number.isFinite(tick) || tick <= 0) continue;
      out.push({
        venueSymbol: s.symbol,
        marketType,
        tickSize: tick,
        lotSize: Number.isFinite(step) && step > 0 ? step : null,
        status: s.status,
      });
    }
    return out;
  }

  health(): ProviderHealth {
    let last: number | null = null;
    let reconnects = 0;
    let connected = this.connections.size > 0;
    for (const c of this.connections) {
      if (c.lastMessageAtMs !== null && (last === null || c.lastMessageAtMs > last))
        last = c.lastMessageAtMs;
      reconnects += c.reconnects;
      connected = connected && c.connected;
    }
    return { connected, lastMessageAtMs: last, reconnects };
  }
}
