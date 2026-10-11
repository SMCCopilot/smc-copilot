import { describe, expect, it } from 'vitest';
import {
  normalizeSymbol,
  type ResolvableInstrument,
  resolveInstrument,
  type SearchKey,
} from '../src/resolve.js';
import { StreamRegistry } from '../src/stream-registry.js';
import { type FeedObservation, feedStatus, WATCHDOG } from '../src/watchdog.js';
import { FakeScheduler } from './fakes.js';

const MIN = 60_000;

describe('feedStatus', () => {
  const base: FeedObservation = {
    nowMs: 10 * MIN + 5000,
    lastMessageAtMs: 10 * MIN + 3000,
    lastClosedOpenMs: 8 * MIN, // closed at 9:00; the next one is due at 10:00
    flatStreak: 0,
    openIncident: false,
    disconnected: false,
  };

  it('is OK while candles and frames keep coming', () => {
    expect(feedStatus(base)).toEqual({ state: 'OK', reasons: [] });
  });

  it('goes DEGRADED after 15 s without any frame, not before', () => {
    expect(feedStatus({ ...base, lastMessageAtMs: base.nowMs - WATCHDOG.silenceMs }).state).toBe(
      'OK',
    );
    expect(feedStatus({ ...base, lastMessageAtMs: base.nowMs - WATCHDOG.silenceMs - 1 })).toEqual({
      state: 'DEGRADED',
      reasons: ['SILENT'],
    });
  });

  it('goes STALE when the expected closed candle is 20 s overdue', () => {
    const due = 8 * MIN + 2 * MIN; // next candle closes at 10:00
    const talking = (nowMs: number) => ({ ...base, nowMs, lastMessageAtMs: nowMs - 1000 });
    expect(feedStatus(talking(due + WATCHDOG.overdueMs)).state).toBe('OK');
    expect(feedStatus(talking(due + WATCHDOG.overdueMs + 1))).toMatchObject({
      state: 'STALE',
      reasons: expect.arrayContaining(['CANDLE_OVERDUE']),
    });
  });

  it('simulated silence of 20 s: DEGRADED first, then STALE once the candle is overdue (B05 W3 D4)', () => {
    const t0 = 10 * MIN; // candle due now
    const at = (offset: number): FeedObservation => ({
      ...base,
      nowMs: t0 + offset,
      lastMessageAtMs: t0 - 1000,
    });
    expect(feedStatus(at(1000)).state).toBe('OK');
    expect(feedStatus(at(17_000)).state).toBe('DEGRADED');
    expect(feedStatus(at(21_000)).state).toBe('STALE');
  });

  it('is STALE before any candle exists and when flat candles repeat', () => {
    expect(feedStatus({ ...base, lastClosedOpenMs: null }).state).toBe('STALE');
    expect(feedStatus({ ...base, flatStreak: 3 })).toMatchObject({
      state: 'STALE',
      reasons: ['FLAT_CANDLES'],
    });
    expect(feedStatus({ ...base, flatStreak: 2 }).state).toBe('OK');
  });

  it('is DEGRADED, never silent, for a cross-check incident or a dropped connection', () => {
    expect(feedStatus({ ...base, openIncident: true })).toEqual({
      state: 'DEGRADED',
      reasons: ['DATA_QUALITY_INCIDENT'],
    });
    expect(feedStatus({ ...base, disconnected: true }).state).toBe('DEGRADED');
  });

  it('STALE outranks DEGRADED but keeps every reason', () => {
    const r = feedStatus({ ...base, lastClosedOpenMs: null, openIncident: true });
    expect(r.state).toBe('STALE');
    expect(r.reasons).toEqual(['NO_CANDLE_YET', 'DATA_QUALITY_INCIDENT']);
  });
});

describe('normalizeSymbol', () => {
  it.each([
    ['BINANCE:BTCUSDT.P', { key: 'BTCUSDT', venue: 'BINANCE', perpMarker: true }],
    ['BTCUSDT', { key: 'BTCUSDT', venue: null, perpMarker: false }],
    ['BTC-USDT-SWAP', { key: 'BTCUSDT', venue: null, perpMarker: true }],
    ['xbt/usd', { key: 'BTCUSD', venue: null, perpMarker: false }],
    ['KRAKEN:XBTUSD', { key: 'BTCUSD', venue: 'KRAKEN', perpMarker: false }],
    ['  eth usdt perp ', { key: 'ETHUSDT', venue: null, perpMarker: true }],
  ])('%s', (input, expected) => {
    expect(normalizeSymbol(input)).toEqual(expected);
  });
});

describe('resolveInstrument', () => {
  const inst = (canonical: string, lastPrice?: number): ResolvableInstrument => {
    const [venue, marketType, symbol] = canonical.split(':') as [
      ResolvableInstrument['venue'],
      'SPOT' | 'PERP',
      string,
    ];
    return { id: canonical, canonical, venue, marketType, display: symbol, lastPrice };
  };
  const instruments = new Map(
    [
      inst('BINANCE:SPOT:BTCUSDT', 64000),
      inst('BINANCE:PERP:BTCUSDT', 64040),
      inst('BYBIT:PERP:BTCUSDT', 64035),
      inst('BINANCE:SPOT:ETHUSDT', 3200),
      inst('COINBASE:SPOT:BTC-USD', 64005),
      inst('KRAKEN:SPOT:XBT/USD', 64002),
    ].map((i) => [i.id, i]),
  );
  const keys: SearchKey[] = [
    ...[
      ['BTCUSDT', 'BINANCE:SPOT:BTCUSDT', 10],
      ['BTCUSDT', 'BINANCE:PERP:BTCUSDT', 9],
      ['BTCUSDTP', 'BINANCE:PERP:BTCUSDT', 10],
      ['BTCUSDT', 'BYBIT:PERP:BTCUSDT', 8],
      ['BTCUSDTP', 'BYBIT:PERP:BTCUSDT', 9],
      ['ETHUSDT', 'BINANCE:SPOT:ETHUSDT', 10],
      ['BTCUSD', 'BINANCE:SPOT:BTCUSDT', 6],
      ['BTCUSD', 'COINBASE:SPOT:BTC-USD', 10],
      ['BTCUSD', 'KRAKEN:SPOT:XBT/USD', 7],
    ].map(([key, instrumentId, weight]) => ({
      key: key as string,
      instrumentId: instrumentId as string,
      weight: weight as number,
    })),
  ];
  const resolve = (q: Parameters<typeof resolveInstrument>[0]) =>
    resolveInstrument(q, keys, instruments);

  it('BINANCE:BTCUSDT.P resolves to the Binance perp, not the spot', () => {
    const r = resolve({ text: 'BINANCE:BTCUSDT.P' });
    expect(r.candidates[0]?.instrument.canonical).toBe('BINANCE:PERP:BTCUSDT');
    expect(r.ambiguous).toBe(false);
  });

  it('BTCUSDT.P without a venue returns perps first and flags the Binance/Bybit tie', () => {
    const r = resolve({ text: 'BTCUSDT.P' });
    expect(r.candidates.map((c) => c.instrument.canonical).slice(0, 2)).toEqual([
      'BINANCE:PERP:BTCUSDT',
      'BYBIT:PERP:BTCUSDT',
    ]);
    expect(r.candidates.at(-1)?.instrument.marketType).toBe('SPOT');
  });

  it('bare BTCUSD is ambiguous across venues, even with a price that matches one of them', () => {
    const r = resolve({ text: 'BTCUSD', lastPrice: 64038 });
    expect(r.candidates.length).toBeGreaterThan(1);
    expect(r.ambiguous).toBe(true);
  });

  it('the venue text settles the tie', () => {
    const r = resolve({ text: 'BTCUSD', venueText: 'Coinbase' });
    expect(r.candidates[0]?.instrument.canonical).toBe('COINBASE:SPOT:BTC-USD');
    expect(r.ambiguous).toBe(false);
  });

  it('drops candidates whose price is more than 5% away (a different asset or scale)', () => {
    expect(resolve({ text: 'ETHUSDT', lastPrice: 64000 }).candidates).toEqual([]);
    expect(resolve({ text: 'ETHUSDT', lastPrice: 3190 }).candidates).toHaveLength(1);
  });

  it('an explicit spot chart prefers the spot market', () => {
    expect(resolve({ text: 'BTCUSDT', isPerp: false }).candidates[0]?.instrument.canonical).toBe(
      'BINANCE:SPOT:BTCUSDT',
    );
  });

  it('returns nothing for an unknown symbol', () => {
    expect(resolve({ text: 'DOGEUSDT' })).toEqual({ candidates: [], ambiguous: false });
  });
});

describe('StreamRegistry', () => {
  const make = () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const clock = new FakeScheduler();
    const registry = new StreamRegistry(
      {
        start: (id) => {
          started.push(id);
          return { stop: () => stopped.push(id) };
        },
      },
      5 * MIN,
      clock,
    );
    return { registry, started, stopped, clock };
  };

  it('starts one stream for many holders', () => {
    const { registry, started } = make();
    registry.acquire('a');
    registry.acquire('a');
    expect(started).toEqual(['a']);
    expect(registry.holderCount('a')).toBe(2);
  });

  it('stops 5 minutes after the last holder leaves, not before', () => {
    const { registry, stopped, clock } = make();
    const r1 = registry.acquire('a');
    const r2 = registry.acquire('a');
    r1();
    clock.advance(10 * MIN);
    expect(stopped).toEqual([]);
    r2();
    clock.advance(5 * MIN - 1);
    expect(stopped).toEqual([]);
    clock.advance(1);
    expect(stopped).toEqual(['a']);
    expect(registry.isActive('a')).toBe(false);
  });

  it('a holder returning during the grace period keeps the stream', () => {
    const { registry, started, stopped, clock } = make();
    registry.acquire('a')();
    clock.advance(4 * MIN);
    registry.acquire('a');
    clock.advance(10 * MIN);
    expect(started).toEqual(['a']);
    expect(stopped).toEqual([]);
  });

  it("releasing twice does not steal another holder's reference", () => {
    const { registry } = make();
    const r1 = registry.acquire('a');
    registry.acquire('a');
    r1();
    r1();
    expect(registry.holderCount('a')).toBe(1);
  });

  it('stopAll stops everything immediately', () => {
    const { registry, stopped } = make();
    registry.acquire('a');
    registry.acquire('b');
    registry.stopAll();
    expect(stopped.sort()).toEqual(['a', 'b']);
  });
});
