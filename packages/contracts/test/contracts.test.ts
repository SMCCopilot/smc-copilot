import { describe, expect, it } from 'vitest';
import {
  ApiProblemSchema,
  assertSameMarketType,
  CANDLE_FLAGS,
  CandleSchema,
  CLIENT_EVENT_TYPES,
  ClientEventSchemas,
  ERROR_STATUS,
  formatCanonical,
  HistoricalStatSchema,
  MarketFactsSchema,
  OcrContextSchema,
  parseCanonical,
  RESERVED_CLIENT_EVENTS,
  SERVER_EVENT_TYPES,
  TIMEFRAME_MS,
  TIMEFRAMES,
  VOICE_FORBIDDEN_ACTIONS,
  WarningEventSchema,
} from '../src/index.js';

const candle = {
  instrumentId: 'BINANCE:PERP:BTCUSDT',
  tf: '1m',
  openTime: 1_760_000_000_000,
  o: 64000.1,
  h: 64020.5,
  l: 63990,
  c: 64010,
  v: 12.345,
  closed: true,
  providerId: 'binance',
};

describe('timeframes', () => {
  it('has a positive millisecond length for every timeframe', () => {
    for (const tf of TIMEFRAMES) expect(TIMEFRAME_MS[tf]).toBeGreaterThan(0);
  });
});

describe('instrument identity (invariant 7)', () => {
  it('round-trips (venue, market type, symbol)', () => {
    const ref = parseCanonical('BINANCE:PERP:BTCUSDT');
    expect(ref).toEqual({ venue: 'BINANCE', marketType: 'PERP', symbol: 'BTCUSDT' });
    expect(formatCanonical(ref)).toBe('BINANCE:PERP:BTCUSDT');
  });

  it('keeps venue-style symbols such as XBT/USD and BTC-USD intact', () => {
    expect(parseCanonical('KRAKEN:SPOT:XBT/USD').symbol).toBe('XBT/USD');
    expect(parseCanonical('COINBASE:SPOT:BTC-USD').symbol).toBe('BTC-USD');
  });

  it.each([
    'BTCUSDT',
    'BINANCE:BTCUSDT',
    'NOPE:SPOT:BTCUSDT',
    'BINANCE:FUTURES:BTCUSDT',
    'BINANCE:PERP:btcusdt',
  ])('rejects %s', (bad) => {
    expect(() => parseCanonical(bad)).toThrow();
  });

  it('cannot build an id that does not parse back', () => {
    expect(() =>
      formatCanonical({ venue: 'BINANCE', marketType: 'PERP', symbol: 'BTC:X' }),
    ).toThrow();
  });

  it('refuses to compare a spot series with a perp series', () => {
    expect(() => assertSameMarketType('BINANCE:SPOT:BTCUSDT', 'BYBIT:PERP:BTCUSDT')).toThrow(
      /cross-market-type/,
    );
    expect(() => assertSameMarketType('BINANCE:PERP:BTCUSDT', 'BYBIT:PERP:BTCUSDT')).not.toThrow();
  });
});

describe('CandleSchema', () => {
  it('accepts a well-formed candle', () => {
    expect(CandleSchema.safeParse(candle).success).toBe(true);
  });

  it.each([
    ['unknown field', { ...candle, extra: 1 }],
    ['non-positive price', { ...candle, l: 0 }],
    ['NaN price', { ...candle, o: Number.NaN }],
    ['negative volume', { ...candle, v: -1 }],
    ['fractional openTime', { ...candle, openTime: 1.5 }],
    ['bad timeframe', { ...candle, tf: '2m' }],
    ['high below close', { ...candle, h: 64000 }],
    ['low above open', { ...candle, l: 64005 }],
  ])('rejects %s', (_label, value) => {
    expect(CandleSchema.safeParse(value).success).toBe(false);
  });

  it('keeps flag bits distinct', () => {
    const bits = Object.values(CANDLE_FLAGS);
    expect(new Set(bits).size).toBe(bits.length);
    for (const b of bits) expect(b & (b - 1)).toBe(0);
  });
});

describe('market facts (invariants 4 and 5)', () => {
  const stat = {
    n: 40,
    rate: 0.4,
    ci95: [0.26, 0.55],
    source: 'BACKTEST',
    window: { from: '2026-01-01', to: '2026-06-01' },
    disclaimerKey: 'HISTORICAL_NOT_FORECAST',
  };

  it('refuses a base rate built on fewer than 30 samples, in the contract itself', () => {
    expect(HistoricalStatSchema.safeParse(stat).success).toBe(true);
    expect(HistoricalStatSchema.safeParse({ ...stat, n: 29 }).success).toBe(false);
  });

  it('does not let unknown data ride into the facts the AI sees', () => {
    const facts = {
      asOf: 1,
      instrumentId: 'BINANCE:PERP:BTCUSDT',
      strategyVersionId: 'v1',
      dataQuality: 'OK',
      htfBias: { tf: '4h', trend: 'BULL', lastBreak: null },
      levels: [],
      zones: [],
      setups: [],
      warnings: [],
    };
    expect(MarketFactsSchema.safeParse(facts).success).toBe(true);
    expect(MarketFactsSchema.safeParse({ ...facts, userEmail: 'a@b.c' }).success).toBe(false);
    expect(
      MarketFactsSchema.safeParse({
        ...facts,
        levels: Array.from({ length: 401 }, (_, i) => ({
          id: `L${i}`,
          label: 'x',
          kind: 'EQL',
          price: 1,
        })),
      }).success,
    ).toBe(false);
  });
});

describe('ApiProblemSchema', () => {
  it('has a 4xx/5xx status for every code', () => {
    for (const status of Object.values(ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('accepts a PLAN_CHANGED problem and rejects an unknown code', () => {
    const ok = {
      type: 'https://docs.example/errors/plan-changed',
      title: 'Plan changed',
      status: 409,
      code: 'PLAN_CHANGED',
      correlationId: 'abc',
    };
    expect(ApiProblemSchema.safeParse(ok).success).toBe(true);
    expect(ApiProblemSchema.safeParse({ ...ok, code: 'MADE_UP' }).success).toBe(false);
    expect(ApiProblemSchema.safeParse({ ...ok, code: 'NOT_FOUND', status: 500 }).success).toBe(
      false,
    );
  });
});

describe('OcrContextSchema (text only, invariant 2)', () => {
  const ocr = {
    capturedAt: 1,
    roi: { w: 600, h: 80 },
    texts: [{ kind: 'SYMBOL', text: 'BTCUSDT.P', conf: 0.97, box: [0, 0, 10, 10] }],
    engine: { name: 'paddleocr-web', version: '1', backend: 'wasm', ms: 120 },
  };

  it('accepts a text-only payload', () => {
    expect(OcrContextSchema.safeParse(ocr).success).toBe(true);
  });

  it.each(['image', 'frame', 'pixels', 'bytes', 'dataUrl'])(
    'rejects a payload that smuggles a %s field',
    (field) => {
      expect(OcrContextSchema.safeParse({ ...ocr, [field]: 'AAAA' }).success).toBe(false);
    },
  );

  it('caps the amount of text a client can send', () => {
    const many = Array.from({ length: 65 }, () => ocr.texts[0]);
    expect(OcrContextSchema.safeParse({ ...ocr, roi: { w: 1e9, h: 10 } }).success).toBe(false);
    expect(OcrContextSchema.safeParse({ ...ocr, texts: many }).success).toBe(false);
    const long = [{ ...ocr.texts[0], text: 'x'.repeat(121) }];
    expect(OcrContextSchema.safeParse({ ...ocr, texts: long }).success).toBe(false);
  });
});

describe('websocket contracts', () => {
  it('validates a warning event envelope', () => {
    const ev = {
      seq: 7,
      type: 'warning',
      at: 1,
      correlationId: 'c',
      payload: { code: 'FEED_STALE' },
    };
    expect(WarningEventSchema.safeParse(ev).success).toBe(true);
    expect(WarningEventSchema.safeParse({ ...ev, type: 'error' }).success).toBe(false);
  });

  it('exposes exactly the reviewed set of client events (nothing can confirm, log, pay or delete)', () => {
    expect([...CLIENT_EVENT_TYPES].sort()).toEqual(
      [
        'analysis.request',
        'chat.cancel',
        'chat.send',
        'context.hint',
        'context.set',
        'explain.cancel',
        'explain.request',
        'session.end',
        'session.pause',
        'session.start',
        'setup.watch',
        'voice.command',
      ].sort(),
    );
    expect(new Set(SERVER_EVENT_TYPES).size).toBe(SERVER_EVENT_TYPES.length);
  });

  it('reserves the Tier 2 voice and frame events instead of silently dropping them', () => {
    expect(RESERVED_CLIENT_EVENTS).toEqual([
      'voice.begin',
      'voice.audio',
      'voice.end',
      'frame.submit',
    ]);
    for (const e of RESERVED_CLIENT_EVENTS) expect(CLIENT_EVENT_TYPES).not.toContain(e);
  });

  it('rejects unknown fields and out-of-range values on client payloads', () => {
    const chat = ClientEventSchemas['chat.send'];
    const ok = {
      clientMsgId: 'm1',
      text: 'why bearish?',
      inputMode: 'voice',
      sttEngine: 'whisper-web',
      sttConfidence: 0.9,
    };
    expect(chat.safeParse(ok).success).toBe(true);
    expect(chat.safeParse({ ...ok, confirmGate: true }).success).toBe(false);
    expect(chat.safeParse({ ...ok, text: 'x'.repeat(2001) }).success).toBe(false);
    expect(chat.safeParse({ ...ok, sttConfidence: 1.5 }).success).toBe(false);
    expect(
      ClientEventSchemas['voice.command'].safeParse({
        utteranceId: 'u',
        text: 'explain',
        sttConfidence: 0.8,
        sttEngine: 'audio-upload',
      }).success,
    ).toBe(false);
  });

  it('lists the actions voice must never perform', () => {
    expect(VOICE_FORBIDDEN_ACTIONS).toEqual(
      expect.arrayContaining(['confirm_gate', 'log_trade', 'delete_account', 'pay']),
    );
  });
});
