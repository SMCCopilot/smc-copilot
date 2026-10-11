import { TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aggregateBucket,
  bucketStart,
  closesBucket,
  constituentOpenTimes,
  DERIVED_TIMEFRAMES,
} from '../src/aggregate.js';
import { FLAG, type StoredCandle } from '../src/candle.js';

const ID = 'BINANCE:PERP:BTCUSDT';
const MIN = 60_000;

const minute = (
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 1,
  flags = 0,
): StoredCandle => ({
  instrumentId: ID,
  tf: '1m',
  openTime,
  o,
  h,
  l,
  c,
  v,
  closed: true,
  providerId: 'binance',
  flags,
  status: 'CLOSED',
});

/** Deterministic random walk of 1m candles starting at `start`. */
const walk = (start: number, n: number, seed: number[]): StoredCandle[] => {
  const out: StoredCandle[] = [];
  let price = 1000;
  for (let i = 0; i < n; i++) {
    const a = (seed[i % seed.length] ?? 0) / 100;
    const o = price;
    const c = Math.max(1, o + a);
    const h = Math.max(o, c) + Math.abs(a) / 2 + 0.01;
    const l = Math.max(0.5, Math.min(o, c) - Math.abs(a) / 3 - 0.01);
    out.push(minute(start + i * MIN, o, h, Math.min(l, o, c), c, 1 + Math.abs(a)));
    price = c;
  }
  return out;
};

/** Obviously-correct reference: filter by bucket, fold. */
const reference = (all: StoredCandle[], bucketOpen: number, tf: Timeframe) => {
  const kids = all.filter(
    (c) => c.openTime >= bucketOpen && c.openTime < bucketOpen + TIMEFRAME_MS[tf],
  );
  if (kids.length === 0) return null;
  const sorted = [...kids].sort((a, b) => a.openTime - b.openTime);
  return {
    o: sorted[0]?.o,
    c: sorted[sorted.length - 1]?.c,
    h: Math.max(...sorted.map((k) => k.h)),
    l: Math.min(...sorted.map((k) => k.l)),
    v: Math.round(sorted.reduce((s, k) => s + k.v, 0) * 1e8) / 1e8,
  };
};

describe('bucket arithmetic', () => {
  it('uses UTC boundaries: 4h at 00/04/08/12/16/20, 1d at 00:00 UTC', () => {
    const t = Date.UTC(2026, 9, 11, 13, 37); // 13:37
    expect(bucketStart(t, '1h')).toBe(Date.UTC(2026, 9, 11, 13));
    expect(bucketStart(t, '4h')).toBe(Date.UTC(2026, 9, 11, 12));
    expect(bucketStart(t, '1d')).toBe(Date.UTC(2026, 9, 11));
    expect(bucketStart(t, '15m')).toBe(Date.UTC(2026, 9, 11, 13, 30));
  });

  it('knows which minute closes a bucket', () => {
    expect(closesBucket(Date.UTC(2026, 0, 1, 0, 4), '5m')).toBe(true);
    expect(closesBucket(Date.UTC(2026, 0, 1, 0, 3), '5m')).toBe(false);
    expect(closesBucket(Date.UTC(2026, 0, 1, 23, 59), '1d')).toBe(true);
    expect(closesBucket(Date.UTC(2026, 0, 1, 3, 59), '4h')).toBe(true);
  });

  it.each(DERIVED_TIMEFRAMES)('%s needs exactly tfMs/60000 constituents', (tf) => {
    expect(constituentOpenTimes(0, tf)).toHaveLength(TIMEFRAME_MS[tf] / MIN);
  });
});

describe('aggregateBucket', () => {
  it('builds OHLCV from a complete bucket and marks it CLOSED', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0);
    const kids = [
      minute(start, 10, 12, 9, 11, 2),
      minute(start + MIN, 11, 15, 10, 14, 3),
      minute(start + 2 * MIN, 14, 14, 8, 9, 4),
      minute(start + 3 * MIN, 9, 10, 9, 10, 1),
      minute(start + 4 * MIN, 10, 11, 10, 10.5, 5),
    ];
    const r = aggregateBucket(kids, start, '5m');
    expect(r?.missing).toEqual([]);
    expect(r?.candle).toMatchObject({
      o: 10,
      h: 15,
      l: 8,
      c: 10.5,
      v: 15,
      status: 'CLOSED',
      closed: true,
      tf: '5m',
    });
  });

  it('never emits CLOSED with a missing constituent (marks it INCOMPLETE and names the gap)', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0);
    const kids = [minute(start, 10, 12, 9, 11), minute(start + 2 * MIN, 11, 12, 10, 12)];
    const r = aggregateBucket(kids, start, '5m');
    expect(r?.candle.status).toBe('INCOMPLETE');
    expect(r?.candle.closed).toBe(false);
    expect(r?.missing).toEqual([start + MIN, start + 3 * MIN, start + 4 * MIN]);
  });

  it('returns null for an empty bucket and ignores children from other buckets', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0);
    expect(aggregateBucket([], start, '5m')).toBeNull();
    expect(aggregateBucket([minute(start + 5 * MIN, 1, 1, 1, 1)], start, '5m')).toBeNull();
  });

  it('ORs the quality flags of the children', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0);
    const kids = Array.from({ length: 5 }, (_, i) =>
      minute(
        start + i * MIN,
        10,
        11,
        9,
        10,
        1,
        i === 2 ? FLAG.SPIKE_SUSPECT : i === 4 ? FLAG.BACKFILLED : 0,
      ),
    );
    expect(aggregateBucket(kids, start, '5m')?.candle.flags).toBe(
      FLAG.SPIKE_SUSPECT | FLAG.BACKFILLED,
    );
  });

  it('is independent of the order children arrive in', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0);
    const kids = walk(start, 15, [3, -5, 7, -2, 9]);
    const shuffled = [...kids].reverse();
    expect(aggregateBucket(shuffled, start, '15m')).toEqual(aggregateBucket(kids, start, '15m'));
  });

  it('matches the reference on a month boundary and on leap day', () => {
    for (const start of [
      Date.UTC(2026, 0, 31, 23, 0),
      Date.UTC(2028, 1, 29, 23, 0),
      Date.UTC(2026, 11, 31, 23, 0),
    ]) {
      const kids = walk(start, 120, [4, -3, 8, -9, 1]);
      for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
        for (const bucket of new Set(kids.map((k) => bucketStart(k.openTime, tf)))) {
          const got = aggregateBucket(kids, bucket, tf);
          const want = reference(kids, bucket, tf);
          expect(
            got && {
              o: got.candle.o,
              h: got.candle.h,
              l: got.candle.l,
              c: got.candle.c,
              v: got.candle.v,
            },
          ).toEqual(want);
        }
      }
    }
  });

  it('matches the reference for random streams (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 1, max: 400 }),
        fc.array(fc.integer({ min: -900, max: 900 }), { minLength: 1, maxLength: 30 }),
        fc.constantFrom('5m', '15m', '1h', '4h', '1d' as const),
        (startMinute, count, seed, tf) => {
          const kids = walk(startMinute * MIN, count, seed);
          for (const bucket of new Set(kids.map((k) => bucketStart(k.openTime, tf as Timeframe)))) {
            const got = aggregateBucket(kids, bucket, tf as Timeframe);
            const want = reference(kids, bucket, tf as Timeframe);
            expect(got?.candle.o).toBe(want?.o);
            expect(got?.candle.c).toBe(want?.c);
            expect(got?.candle.h).toBe(want?.h);
            expect(got?.candle.l).toBe(want?.l);
            expect(got?.candle.v).toBe(want?.v);
            // A bucket is CLOSED exactly when all of its minutes are present.
            const present = kids.filter(
              (k) => bucketStart(k.openTime, tf as Timeframe) === bucket,
            ).length;
            expect(got?.candle.status === 'CLOSED').toBe(
              present === TIMEFRAME_MS[tf as Timeframe] / MIN,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
