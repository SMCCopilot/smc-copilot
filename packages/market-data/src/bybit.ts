import { type MarketType, TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import type { RawCandle } from './candle.js';
import { parseBybitFrame } from './frames.js';
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

export interface BybitOptions {
  /** `wss://stream.bybit.com/v5/public/linear`: USDT perpetuals only in the MVP (cross-check venue). */
  readonly wsUrl: string;
  readonly restUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly socketFactory?: SocketFactory;
  readonly scheduler?: Scheduler;
}

const PAGE = 1000;
const INTERVAL: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
};

export class BybitProvider implements MarketDataProvider {
  readonly id = 'bybit' as const;
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

  constructor(private readonly options: BybitOptions) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.clock = options.scheduler ?? realScheduler;
    this.limiter = new TokenBucket(
      200,
      10,
      () => this.clock.now(),
      (ms) => new Promise((resolve) => this.clock.setTimeout(resolve, ms)),
    );
  }

  async subscribe(specs: readonly SubscriptionSpec[], sink: CandleSink): Promise<Subscription> {
    const symbols = specs.filter((s) => s.marketType === 'PERP' && s.tf === '1m');
    if (symbols.length === 0) return { close: () => {} };
    const args = symbols.map((s) => `kline.1.${s.venueSymbol.toUpperCase()}`);
    const conn = new ManagedConnection({
      url: this.options.wsUrl,
      factory: this.socketFactory,
      scheduler: this.clock,
      onOpen: (send) => send(JSON.stringify({ op: 'subscribe', args })),
      onMessage: (text, at) => {
        for (const candle of parseBybitFrame(text, at)) sink.onRaw(candle);
      },
      onStatus: (status, detail) => sink.onStatus(status, detail),
      // Bybit wants a ping every 20 s; the pong keeps the silence watchdog quiet while the venue is healthy.
      ping: { everyMs: 20_000, payload: JSON.stringify({ op: 'ping' }) },
      silenceTimeoutMs: 60_000,
      classifyFailure: () => this.classify(),
    });
    this.connections.add(conn);
    conn.start();
    return {
      close: () => {
        conn.close();
        this.connections.delete(conn);
      },
    };
  }

  private async classify(): Promise<FeedStatus | null> {
    try {
      await getJson(`${this.options.restUrl}/v5/market/time`, {
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
        `${this.options.restUrl}/v5/market/kline?category=linear&symbol=${encodeURIComponent(request.venueSymbol)}` +
        `&interval=${INTERVAL[request.tf]}&start=${from}&end=${request.toMs - 1}&limit=${PAGE}`;
      const body = (await getJson(url, { fetchImpl: this.fetchImpl, limiter: this.limiter })) as {
        retCode?: number;
        result?: { list?: string[][] };
      };
      if (body.retCode !== 0) throw new Error(`Bybit klines returned retCode ${body.retCode}`);
      const list = body.result?.list ?? [];
      if (list.length === 0) return;
      const now = this.clock.now();
      // Bybit returns newest first; adapters always emit oldest first (A03 normalisation notes).
      const page: RawCandle[] = [...list].reverse().flatMap((row) => {
        const openTimeMs = Number(row[0]);
        if (!Number.isFinite(openTimeMs)) return [];
        return [
          {
            venueSymbol: request.venueSymbol,
            marketType: 'PERP' as const,
            tf: request.tf,
            openTimeMs,
            o: String(row[1]),
            h: String(row[2]),
            l: String(row[3]),
            c: String(row[4]),
            v: String(row[5]),
            closed: now >= openTimeMs + tfMs,
            receivedAtMs: now,
          },
        ];
      });
      if (page.length === 0) return;
      yield page;
      const last = page[page.length - 1]?.openTimeMs ?? from;
      if (last < from || list.length < PAGE) return;
      from = last + tfMs;
    }
  }

  async fetchMarkets(symbols: readonly string[], marketType: MarketType): Promise<VenueMarket[]> {
    if (marketType !== 'PERP') return [];
    const out: VenueMarket[] = [];
    for (const symbol of symbols) {
      const body = (await getJson(
        `${this.options.restUrl}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`,
        { fetchImpl: this.fetchImpl, limiter: this.limiter },
      )) as {
        result?: {
          list?: {
            symbol: string;
            status: string;
            priceFilter?: { tickSize?: string };
            lotSizeFilter?: { qtyStep?: string };
          }[];
        };
      };
      for (const m of body.result?.list ?? []) {
        const tick = Number(m.priceFilter?.tickSize);
        const step = Number(m.lotSizeFilter?.qtyStep);
        if (!Number.isFinite(tick) || tick <= 0) continue;
        out.push({
          venueSymbol: m.symbol,
          marketType,
          tickSize: tick,
          lotSize: Number.isFinite(step) && step > 0 ? step : null,
          status: m.status,
        });
      }
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
