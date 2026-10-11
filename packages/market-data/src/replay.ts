import type { MarketType } from '@smc/contracts';
import type { RawCandle } from './candle.js';
import { parseBinanceFrame, parseBybitFrame } from './frames.js';
import {
  type CandleSink,
  type FetchRequest,
  type MarketDataProvider,
  NotEnabledError,
  type ProviderHealth,
  type Subscription,
  type SubscriptionSpec,
  type VenueMarket,
} from './provider.js';

/** One recorded WebSocket frame: `{"t": receivedAtMs, "raw": "<frame text>"}` per line (the S2 recorder's format). */
export interface RecordedFrame {
  readonly t: number;
  readonly raw: string;
}

export function parseRecording(jsonl: string): RecordedFrame[] {
  const out: RecordedFrame[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { t?: unknown; raw?: unknown };
    if (typeof row.t === 'number' && typeof row.raw === 'string')
      out.push({ t: row.t, raw: row.raw });
  }
  return out;
}

export type FrameKind = 'binance' | 'bybit';

export interface ReplayOptions {
  /** Which venue's frame format the recording holds. */
  readonly kind: FrameKind;
  readonly marketType: MarketType;
  /** 0 = deliver everything immediately; otherwise recorded gaps are divided by this factor. */
  readonly speed?: number;
  /** Candle history served by `fetchCandles` (tests and demo mode). */
  readonly history?: readonly RawCandle[];
}

/**
 * Replays a recording through the same frame parsers the live adapters use, so the backtester, CI and demo mode
 * run the production pipeline on stored data (A03 section 3). Deterministic: output depends only on the recording.
 */
export class ReplayProvider implements MarketDataProvider {
  readonly id = 'replay' as const;
  readonly capabilities = {
    streamsClosedCandles: true,
    nativeTimeframes: ['1m'] as const,
    supportsTicks: false,
  };
  private delivered = 0;
  private last: number | null = null;

  constructor(
    private readonly frames: readonly RecordedFrame[],
    private readonly options: ReplayOptions,
  ) {}

  async subscribe(specs: readonly SubscriptionSpec[], sink: CandleSink): Promise<Subscription> {
    const wanted = new Set(specs.map((s) => s.venueSymbol.toUpperCase()));
    let stopped = false;
    sink.onStatus('CONNECTED');
    const run = async () => {
      let previousT: number | null = null;
      for (const frame of this.frames) {
        if (stopped) return;
        const speed = this.options.speed ?? 0;
        if (speed > 0 && previousT !== null) {
          const wait = Math.max(0, (frame.t - previousT) / speed);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          await Promise.resolve();
        }
        previousT = frame.t;
        const candles =
          this.options.kind === 'binance'
            ? parseBinanceFrame(frame.raw, this.options.marketType, frame.t)
            : parseBybitFrame(frame.raw, frame.t);
        for (const candle of candles) {
          if (wanted.size > 0 && !wanted.has(candle.venueSymbol.toUpperCase())) continue;
          this.delivered += 1;
          this.last = frame.t;
          sink.onRaw(candle);
        }
      }
      if (!stopped) sink.onStatus('DISCONNECTED', 'end of recording');
    };
    void run();
    return { close: () => (stopped = true) };
  }

  async *fetchCandles(request: FetchRequest): AsyncIterable<RawCandle[]> {
    const page = (this.options.history ?? []).filter(
      (c) =>
        c.venueSymbol === request.venueSymbol &&
        c.marketType === request.marketType &&
        c.openTimeMs >= request.fromMs &&
        c.openTimeMs < request.toMs,
    );
    if (page.length > 0) yield [...page].sort((a, b) => a.openTimeMs - b.openTimeMs);
  }

  async fetchMarkets(): Promise<VenueMarket[]> {
    return [];
  }

  health(): ProviderHealth {
    return { connected: true, lastMessageAtMs: this.last, reconnects: 0 };
  }
}

/** The forex seam (A03 section 2.4): implements the interface and refuses to work until a licence decision exists. */
export class FxStubProvider implements MarketDataProvider {
  readonly id = 'fx-stub' as const;
  readonly capabilities = {
    streamsClosedCandles: false,
    nativeTimeframes: [] as const,
    supportsTicks: false,
  };

  subscribe(): Promise<Subscription> {
    return Promise.reject(new NotEnabledError('forex market data'));
  }
  // biome-ignore lint/correctness/useYield: always throws NOT_ENABLED
  async *fetchCandles(): AsyncIterable<RawCandle[]> {
    throw new NotEnabledError('forex market data');
  }
  fetchMarkets(): Promise<VenueMarket[]> {
    return Promise.reject(new NotEnabledError('forex market data'));
  }
  health(): ProviderHealth {
    return { connected: false, lastMessageAtMs: null, reconnects: 0 };
  }
}
