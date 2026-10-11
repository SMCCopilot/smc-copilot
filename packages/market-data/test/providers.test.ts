import { describe, expect, it } from 'vitest';
import { BinanceProvider } from '../src/binance.js';
import { BybitProvider } from '../src/bybit.js';
import type { RawCandle } from '../src/candle.js';
import { parseBinanceFrame, parseBybitFrame } from '../src/frames.js';
import type { FetchLike } from '../src/http.js';
import { TokenBucket } from '../src/http.js';
import {
  type CandleSink,
  GeoBlockedError,
  NotEnabledError,
  RateLimitedError,
} from '../src/provider.js';
import { FxStubProvider, parseRecording, ReplayProvider } from '../src/replay.js';
import { FakeScheduler, FakeSocket } from './fakes.js';

const T = 1_760_000_000_000;

const binanceFrame = (x: boolean, symbol = 'BTCUSDT', t = T, wrapped = true) => {
  const event = {
    e: 'kline',
    E: t + 59_999 + 100,
    s: symbol,
    k: {
      t,
      T: t + 59_999,
      s: symbol,
      i: '1m',
      o: '64000.10',
      c: '64010.00',
      h: '64020.50',
      l: '63990.00',
      v: '12.345',
      x,
    },
  };
  return JSON.stringify(
    wrapped ? { stream: `${symbol.toLowerCase()}@kline_1m`, data: event } : event,
  );
};
const bybitFrame = (confirm: boolean, symbol = 'BTCUSDT', start = T) =>
  JSON.stringify({
    topic: `kline.1.${symbol}`,
    type: 'snapshot',
    ts: start + 61_000,
    data: [
      {
        start,
        end: start + 59_999,
        interval: '1',
        open: '64000.1',
        close: '64010',
        high: '64020.5',
        low: '63990',
        volume: '12.3',
        confirm,
      },
    ],
  });

describe('parseBinanceFrame', () => {
  it('emits a closed kline from a combined-stream frame', () => {
    expect(parseBinanceFrame(binanceFrame(true), 'PERP', 5)).toEqual([
      {
        venueSymbol: 'BTCUSDT',
        marketType: 'PERP',
        tf: '1m',
        openTimeMs: T,
        o: '64000.10',
        h: '64020.50',
        l: '63990.00',
        c: '64010.00',
        v: '12.345',
        closed: true,
        receivedAtMs: 5,
      },
    ]);
  });
  it('accepts a single-stream frame too', () => {
    expect(parseBinanceFrame(binanceFrame(true, 'ETHUSDT', T, false), 'SPOT', 5)).toHaveLength(1);
  });
  it('drops forming updates unless asked', () => {
    expect(parseBinanceFrame(binanceFrame(false), 'SPOT', 5)).toEqual([]);
    expect(
      parseBinanceFrame(binanceFrame(false), 'SPOT', 5, { includeForming: true })[0]?.closed,
    ).toBe(false);
  });
  it.each([
    ['not json', 'pong'],
    ['ack', '{"result":null,"id":1}'],
    ['other interval', binanceFrame(true).replace('"i":"1m"', '"i":"5m"')],
    ['missing price', binanceFrame(true).replace('"o":"64000.10",', '')],
    [
      'numeric price (venue sends strings)',
      binanceFrame(true).replace('"h":"64020.50"', '"h":64020.5'),
    ],
    ['non-kline event', JSON.stringify({ e: 'trade', s: 'BTCUSDT' })],
    ['null', 'null'],
  ])('ignores %s without throwing', (_label, text) => {
    expect(parseBinanceFrame(text, 'SPOT', 5)).toEqual([]);
  });
});

describe('parseBybitFrame', () => {
  it('emits only confirmed candles, as perps', () => {
    expect(parseBybitFrame(bybitFrame(true), 5)).toEqual([
      {
        venueSymbol: 'BTCUSDT',
        marketType: 'PERP',
        tf: '1m',
        openTimeMs: T,
        o: '64000.1',
        h: '64020.5',
        l: '63990',
        c: '64010',
        v: '12.3',
        closed: true,
        receivedAtMs: 5,
      },
    ]);
    expect(parseBybitFrame(bybitFrame(false), 5)).toEqual([]);
  });
  it.each([
    ['pong', '{"success":true,"ret_msg":"pong","op":"ping"}'],
    ['ack', '{"success":true,"op":"subscribe"}'],
    ['other topic', bybitFrame(true).replace('kline.1.', 'kline.5.')],
    ['garbage', '{'],
  ])('ignores %s', (_label, text) => {
    expect(parseBybitFrame(text, 5)).toEqual([]);
  });
});

const sinkOf = () => {
  const raws: RawCandle[] = [];
  const statuses: string[] = [];
  const sink: CandleSink = { onRaw: (c) => raws.push(c), onStatus: (s) => statuses.push(s) };
  return { raws, statuses, sink };
};

describe('BinanceProvider.subscribe', () => {
  const make = () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeScheduler();
    const provider = new BinanceProvider({
      wsUrl: { SPOT: 'wss://spot.example', PERP: 'wss://perp.example/market' },
      restUrl: { SPOT: 'https://spot.example', PERP: 'https://perp.example' },
      socketFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      scheduler: clock,
    });
    return { provider, sockets, clock };
  };

  it('opens one combined-stream connection per market type with every stream in the URL', async () => {
    const { provider, sockets } = make();
    const { sink } = sinkOf();
    await provider.subscribe(
      [
        { venueSymbol: 'BTCUSDT', marketType: 'SPOT', tf: '1m' },
        { venueSymbol: 'ETHUSDT', marketType: 'SPOT', tf: '1m' },
        { venueSymbol: 'BTCUSDT', marketType: 'PERP', tf: '1m' },
      ],
      sink,
    );
    expect(sockets.map((s) => s.url)).toEqual([
      'wss://spot.example/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m',
      'wss://perp.example/market/stream?streams=btcusdt@kline_1m',
    ]);
  });

  it('keeps spot and perp series apart: each connection tags its candles with its own market type', async () => {
    const { provider, sockets } = make();
    const { sink, raws } = sinkOf();
    await provider.subscribe(
      [
        { venueSymbol: 'BTCUSDT', marketType: 'SPOT', tf: '1m' },
        { venueSymbol: 'BTCUSDT', marketType: 'PERP', tf: '1m' },
      ],
      sink,
    );
    for (const s of sockets) s.open();
    sockets[0]?.message(binanceFrame(true));
    sockets[1]?.message(binanceFrame(true));
    expect(raws.map((r) => r.marketType)).toEqual(['SPOT', 'PERP']);
  });

  it('only forwards closed candles and reports connection status', async () => {
    const { provider, sockets } = make();
    const { sink, raws, statuses } = sinkOf();
    await provider.subscribe([{ venueSymbol: 'BTCUSDT', marketType: 'SPOT', tf: '1m' }], sink);
    sockets[0]?.open();
    sockets[0]?.message(binanceFrame(false));
    sockets[0]?.message(binanceFrame(true));
    expect(raws).toHaveLength(1);
    expect(statuses).toEqual(['CONNECTED']);
  });

  it('rotates the connection before the 24 hour limit without a gap or a duplicate subscription', async () => {
    const { provider, sockets, clock } = make();
    const { sink, raws, statuses } = sinkOf();
    await provider.subscribe([{ venueSymbol: 'BTCUSDT', marketType: 'SPOT', tf: '1m' }], sink);
    sockets[0]?.open();
    sockets[0]?.message(binanceFrame(true));
    // The venue keeps talking all day (a silent socket would be reconnected by the watchdog).
    for (let elapsed = 0; elapsed < 23 * 3_600_000 + 50 * 60_000; elapsed += 30_000) {
      clock.advance(30_000);
      sockets[0]?.message('{"heartbeat":true}');
    }
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    sockets[0]?.message(binanceFrame(true, 'BTCUSDT', T + 60_000));
    sockets[1]?.message(binanceFrame(true, 'BTCUSDT', T + 60_000)); // same minute on both during the overlap
    expect(statuses).toEqual(['CONNECTED', 'ROTATED']);
    expect(raws.map((r) => r.openTimeMs)).toEqual([T, T + 60_000, T + 60_000]); // duplicates are the pipeline's job (V5)
  });

  it('close() shuts every connection and stops reconnecting', async () => {
    const { provider, sockets, clock } = make();
    const { sink } = sinkOf();
    const sub = await provider.subscribe(
      [{ venueSymbol: 'BTCUSDT', marketType: 'SPOT', tf: '1m' }],
      sink,
    );
    sockets[0]?.open();
    sub.close();
    sockets[0]?.emit('close', {});
    clock.advance(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(provider.health().connected).toBe(false);
  });
});

describe('BybitProvider.subscribe', () => {
  it('subscribes to every kline topic on open and pings every 20 s', async () => {
    const sockets: FakeSocket[] = [];
    const clock = new FakeScheduler();
    const provider = new BybitProvider({
      wsUrl: 'wss://bybit.example/v5/public/linear',
      restUrl: 'https://bybit.example',
      socketFactory: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      scheduler: clock,
    });
    const { sink, raws } = sinkOf();
    await provider.subscribe(
      [
        { venueSymbol: 'BTCUSDT', marketType: 'PERP', tf: '1m' },
        { venueSymbol: 'ETHUSDT', marketType: 'PERP', tf: '1m' },
        { venueSymbol: 'BTCUSDT', marketType: 'SPOT', tf: '1m' }, // not served by this adapter
      ],
      sink,
    );
    sockets[0]?.open();
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({
      op: 'subscribe',
      args: ['kline.1.BTCUSDT', 'kline.1.ETHUSDT'],
    });
    clock.advance(40_000);
    expect(sockets[0]?.sent.filter((m) => m.includes('"ping"'))).toHaveLength(2);
    sockets[0]?.message(bybitFrame(true));
    expect(raws).toHaveLength(1);
  });
});

const okJson = (body: unknown): ReturnType<FetchLike> =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const status = (code: number, headers: Record<string, string> = {}): ReturnType<FetchLike> =>
  Promise.resolve({
    ok: code < 300,
    status: code,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    json: async () => ({}),
  });

describe('REST history', () => {
  const kline = (t: number) => [t, '1', '2', '0.5', '1.5', '10', t + 59_999];

  it('Binance pages forward until a short page, flags the forming candle as not closed', async () => {
    const calls: string[] = [];
    const clock = new FakeScheduler();
    const now = clock.now();
    const start = Math.floor(now / 60_000) * 60_000 - 1500 * 60_000;
    const pages = [
      Array.from({ length: 1000 }, (_, i) => kline(start + i * 60_000)),
      Array.from({ length: 3 }, (_, i) => kline(start + (1000 + i) * 60_000)),
    ];
    const provider = new BinanceProvider({
      wsUrl: { SPOT: 'wss://x', PERP: 'wss://y' },
      restUrl: { SPOT: 'https://spot.example', PERP: 'https://perp.example' },
      fetchImpl: (url) => {
        calls.push(url);
        return okJson(pages.shift() ?? []);
      },
      scheduler: clock,
    });
    const got: RawCandle[] = [];
    for await (const page of provider.fetchCandles({
      venueSymbol: 'BTCUSDT',
      marketType: 'PERP',
      tf: '1m',
      fromMs: start,
      toMs: start + 2000 * 60_000,
    }))
      got.push(...page);
    expect(got).toHaveLength(1003);
    expect(got.map((c) => c.openTimeMs)).toEqual(
      [...got.map((c) => c.openTimeMs)].sort((a, b) => a - b),
    );
    expect(calls[0]).toContain(
      'https://perp.example/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=',
    );
    expect(calls[1]).toContain(`startTime=${start + 1000 * 60_000}`);
    expect(got.every((c) => c.closed)).toBe(true);
  });

  it('serves native higher-timeframe history for warm-up seeding (4h on Binance, 240 on Bybit)', async () => {
    const urls: string[] = [];
    const clock = new FakeScheduler();
    const h4 = 4 * 3_600_000;
    const start = Math.floor(clock.now() / h4) * h4 - 10 * h4;
    const binance = new BinanceProvider({
      wsUrl: { SPOT: 'wss://x', PERP: 'wss://y' },
      restUrl: { SPOT: 'https://s', PERP: 'https://p' },
      fetchImpl: (u) => {
        urls.push(u);
        return okJson([kline(start), kline(start + h4)]);
      },
      scheduler: clock,
    });
    const got: RawCandle[] = [];
    for await (const page of binance.fetchCandles({
      venueSymbol: 'BTCUSDT',
      marketType: 'SPOT',
      tf: '4h',
      fromMs: start,
      toMs: start + 4 * h4,
    }))
      got.push(...page);
    expect(urls[0]).toContain('interval=4h');
    expect(got.map((c) => [c.tf, c.closed])).toEqual([
      ['4h', true],
      ['4h', true],
    ]);
    const bybitUrls: string[] = [];
    const bybit = new BybitProvider({
      wsUrl: 'wss://x',
      restUrl: 'https://b',
      fetchImpl: (u) => {
        bybitUrls.push(u);
        return okJson({ retCode: 0, result: { list: [] } });
      },
      scheduler: clock,
    });
    for await (const _ of bybit.fetchCandles({
      venueSymbol: 'BTCUSDT',
      marketType: 'PERP',
      tf: '4h',
      fromMs: start,
      toMs: start + h4,
    }))
      void _;
    expect(bybitUrls[0]).toContain('interval=240');
  });

  it('Binance marks a candle that has not finished as not closed', async () => {
    const clock = new FakeScheduler();
    const open = Math.floor(clock.now() / 60_000) * 60_000;
    const provider = new BinanceProvider({
      wsUrl: { SPOT: 'wss://x', PERP: 'wss://y' },
      restUrl: { SPOT: 'https://spot.example', PERP: 'https://perp.example' },
      fetchImpl: () => okJson([kline(open)]),
      scheduler: clock,
    });
    const got: RawCandle[] = [];
    for await (const page of provider.fetchCandles({
      venueSymbol: 'BTCUSDT',
      marketType: 'SPOT',
      tf: '1m',
      fromMs: open,
      toMs: open + 60_000,
    }))
      got.push(...page);
    expect(got[0]?.closed).toBe(false);
  });

  it('Bybit reverses newest-first pages into oldest-first', async () => {
    const clock = new FakeScheduler();
    const base = clock.now() - 10 * 60_000;
    const t = Math.floor(base / 60_000) * 60_000;
    const rows = [t + 120_000, t + 60_000, t].map((x) => [
      String(x),
      '1',
      '2',
      '0.5',
      '1.5',
      '10',
      '100',
    ]);
    const provider = new BybitProvider({
      wsUrl: 'wss://x',
      restUrl: 'https://bybit.example',
      fetchImpl: () => okJson({ retCode: 0, result: { list: rows } }),
      scheduler: clock,
    });
    const got: RawCandle[] = [];
    for await (const page of provider.fetchCandles({
      venueSymbol: 'BTCUSDT',
      marketType: 'PERP',
      tf: '1m',
      fromMs: t,
      toMs: t + 180_000,
    }))
      got.push(...page);
    expect(got.map((c) => c.openTimeMs)).toEqual([t, t + 60_000, t + 120_000]);
  });

  it('Bybit walks a range longer than one page backwards and still returns every candle oldest first', async () => {
    const clock = new FakeScheduler();
    const top = Math.floor(clock.now() / 60_000) * 60_000 - 30 * 60_000;
    const total = 2500;
    const start = top - total * 60_000;
    // The venue serves the newest 1000 rows inside [start, end], newest first.
    const venue = (url: string) => {
      const q = new URL(url).searchParams;
      const s = Number(q.get('start'));
      const e = Number(q.get('end'));
      const rows: string[][] = [];
      for (
        let t = Math.floor(Math.min(e, top - 60_000) / 60_000) * 60_000;
        t >= s && rows.length < 1000;
        t -= 60_000
      ) {
        rows.push([String(t), '1', '2', '0.5', '1.5', '10', '100']);
      }
      return okJson({ retCode: 0, result: { list: rows } });
    };
    const bybit = new BybitProvider({
      wsUrl: 'wss://x',
      restUrl: 'https://b',
      fetchImpl: venue,
      scheduler: clock,
    });
    const got: RawCandle[] = [];
    for await (const page of bybit.fetchCandles({
      venueSymbol: 'BTCUSDT',
      marketType: 'PERP',
      tf: '1m',
      fromMs: start,
      toMs: top,
    }))
      got.push(...page);
    expect(got).toHaveLength(total);
    expect(got[0]?.openTimeMs).toBe(start);
    expect(got.at(-1)?.openTimeMs).toBe(top - 60_000);
    expect(new Set(got.map((c) => c.openTimeMs)).size).toBe(total);
    expect(got.map((c) => c.openTimeMs)).toEqual(
      [...got.map((c) => c.openTimeMs)].sort((a, b) => a - b),
    );
  });

  it('turns HTTP 451/403 into GeoBlockedError and 429 into RateLimitedError with the venue wait', async () => {
    const make = (code: number, headers?: Record<string, string>) =>
      new BinanceProvider({
        wsUrl: { SPOT: 'wss://x', PERP: 'wss://y' },
        restUrl: { SPOT: 'https://s', PERP: 'https://p' },
        fetchImpl: () => status(code, headers),
        scheduler: new FakeScheduler(),
      });
    const drain = async (p: BinanceProvider) => {
      for await (const _ of p.fetchCandles({
        venueSymbol: 'BTCUSDT',
        marketType: 'SPOT',
        tf: '1m',
        fromMs: 0,
        toMs: 60_000,
      }))
        void _;
    };
    await expect(drain(make(451))).rejects.toBeInstanceOf(GeoBlockedError);
    await expect(drain(make(403))).rejects.toBeInstanceOf(GeoBlockedError);
    await expect(drain(make(429, { 'retry-after': '7' }))).rejects.toMatchObject({
      retryAfterMs: 7000,
    });
    await expect(drain(make(429))).rejects.toBeInstanceOf(RateLimitedError);
    await expect(drain(make(500))).rejects.toThrow(/HTTP 500/);
  });

  it('reads tick and lot size from the venue instrument endpoints', async () => {
    const binance = new BinanceProvider({
      wsUrl: { SPOT: 'wss://x', PERP: 'wss://y' },
      restUrl: { SPOT: 'https://s', PERP: 'https://p' },
      fetchImpl: () =>
        okJson({
          symbols: [
            {
              symbol: 'BTCUSDT',
              status: 'TRADING',
              filters: [
                { filterType: 'PRICE_FILTER', tickSize: '0.10' },
                { filterType: 'LOT_SIZE', stepSize: '0.001' },
              ],
            },
            { symbol: 'OTHER', status: 'TRADING', filters: [] },
          ],
        }),
      scheduler: new FakeScheduler(),
    });
    expect(await binance.fetchMarkets(['BTCUSDT'], 'PERP')).toEqual([
      {
        venueSymbol: 'BTCUSDT',
        marketType: 'PERP',
        tickSize: 0.1,
        lotSize: 0.001,
        status: 'TRADING',
      },
    ]);
    const bybit = new BybitProvider({
      wsUrl: 'wss://x',
      restUrl: 'https://b',
      fetchImpl: () =>
        okJson({
          result: {
            list: [
              {
                symbol: 'ETHUSDT',
                status: 'Trading',
                priceFilter: { tickSize: '0.01' },
                lotSizeFilter: { qtyStep: '0.01' },
              },
            ],
          },
        }),
      scheduler: new FakeScheduler(),
    });
    expect(await bybit.fetchMarkets(['ETHUSDT'], 'PERP')).toHaveLength(1);
    expect(await bybit.fetchMarkets(['ETHUSDT'], 'SPOT')).toEqual([]);
  });
});

describe('TokenBucket', () => {
  it('lets bursts through up to capacity then waits for refill', async () => {
    let now = 0;
    const slept: number[] = [];
    const bucket = new TokenBucket(
      10,
      5,
      () => now,
      async (ms) => {
        slept.push(ms);
        now += ms;
      },
    );
    await bucket.take(10);
    expect(slept).toEqual([]);
    await bucket.take(5);
    expect(slept).toEqual([1000]);
  });
});

describe('ReplayProvider', () => {
  const lines = [
    JSON.stringify({ t: 1000, raw: binanceFrame(false) }),
    JSON.stringify({ t: 2000, raw: binanceFrame(true) }),
    '',
    JSON.stringify({ t: 3000, raw: 'pong' }),
    JSON.stringify({ t: 4000, raw: binanceFrame(true, 'ETHUSDT', T + 60_000) }),
  ].join('\n');

  it('replays a recording through the live parsers, filtered to the subscribed symbols', async () => {
    const provider = new ReplayProvider(parseRecording(lines), {
      kind: 'binance',
      marketType: 'PERP',
    });
    const { sink, raws, statuses } = sinkOf();
    await provider.subscribe([{ venueSymbol: 'BTCUSDT', marketType: 'PERP', tf: '1m' }], sink);
    await new Promise((r) => setTimeout(r, 30));
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ venueSymbol: 'BTCUSDT', openTimeMs: T, receivedAtMs: 2000 });
    expect(statuses).toEqual(['CONNECTED', 'DISCONNECTED']);
  });

  it('is deterministic: two replays give identical candles', async () => {
    const run = async () => {
      const provider = new ReplayProvider(parseRecording(lines), {
        kind: 'binance',
        marketType: 'PERP',
      });
      const { sink, raws } = sinkOf();
      await provider.subscribe([], sink);
      await new Promise((r) => setTimeout(r, 30));
      return raws;
    };
    expect(await run()).toEqual(await run());
  });
});

describe('FxStubProvider', () => {
  it('refuses to do anything until forex is enabled', async () => {
    const fx = new FxStubProvider();
    await expect(fx.subscribe()).rejects.toBeInstanceOf(NotEnabledError);
    await expect(fx.fetchMarkets()).rejects.toBeInstanceOf(NotEnabledError);
    await expect(
      (async () => {
        for await (const _ of fx.fetchCandles()) void _;
      })(),
    ).rejects.toBeInstanceOf(NotEnabledError);
  });
});
