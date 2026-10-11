import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { config, run } from './helpers.js';

type Row = readonly [number, number, number, number];
const TF_MS = 900_000;

/** A random walk with integer prices so scaling/shifting stays exact. */
const walk = (min: number, max: number) =>
  fc
    .array(fc.tuple(fc.integer({ min: -40, max: 40 }), fc.nat(25), fc.nat(25)), {
      minLength: min,
      maxLength: max,
    })
    .map((steps) => {
      let price = 100_000;
      return steps.map(([d, up, down]): Row => {
        const o = price;
        const c = Math.max(1000, o + d);
        price = c;
        return [o, Math.max(o, c) + up, Math.max(1, Math.min(o, c) - down), c];
      });
    });

// Small swings so short random walks actually produce structure.
const cfg = config((c) => {
  (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
  (c.swings as { external: { L: number; R: number } }).external = { L: 5, R: 5 };
});
const closeOf = (i: number) => (i + 1) * TF_MS;
const key = (e: { id: string; type: string; time: number; data: unknown }) =>
  JSON.stringify([e.id, e.type, e.time, e.data]);

describe('engine properties', () => {
  it('no look-ahead: truncating or altering the future never changes earlier events', () => {
    fc.assert(
      fc.property(walk(30, 160), walk(1, 60), fc.nat(), (rows, otherFuture, pick) => {
        const cut = 10 + (pick % (rows.length - 10));
        const full = run(rows, cfg).filter((e) => e.time <= closeOf(cut - 1));
        const truncated = run(rows.slice(0, cut), cfg);
        expect(truncated.map(key)).toEqual(full.map(key));

        const last = (rows[cut - 1] as Row)[3];
        const shifted = otherFuture.map(
          (r): Row => [
            r[0] - 100_000 + last,
            r[1] - 100_000 + last,
            Math.max(1, r[2] - 100_000 + last),
            r[3] - 100_000 + last,
          ],
        );
        const altered = run([...rows.slice(0, cut), ...shifted], cfg).filter(
          (e) => e.time <= closeOf(cut - 1),
        );
        expect(altered.map(key)).toEqual(truncated.map(key));
      }),
      { numRuns: 1000 },
    );
  }, 120_000);

  it('determinism: the same candles give a byte-identical event stream', () => {
    fc.assert(
      fc.property(walk(20, 200), (rows) => {
        expect(JSON.stringify(run(rows, cfg))).toBe(JSON.stringify(run(rows, cfg)));
      }),
      { numRuns: 200 },
    );
  }, 120_000);

  it('events never precede the bars they depend on', () => {
    fc.assert(
      fc.property(walk(20, 200), (rows) => {
        for (const e of run(rows, cfg)) {
          expect(e.time).toBeGreaterThanOrEqual(e.anchorOpenTime + TF_MS);
          expect(e.time).toBeLessThanOrEqual(closeOf(rows.length - 1));
        }
      }),
      { numRuns: 200 },
    );
  }, 120_000);

  it('scale and shift invariance: structure is unchanged by x2 and +offset', () => {
    const shape = (rows: readonly Row[]) =>
      run(rows, cfg).map((e) => [e.type, e.scale, e.time, e.anchorOpenTime] as const);
    fc.assert(
      fc.property(walk(20, 160), (rows) => {
        const base = shape(rows);
        expect(shape(rows.map((r): Row => [r[0] * 2, r[1] * 2, r[2] * 2, r[3] * 2]))).toEqual(base);
        expect(
          shape(rows.map((r): Row => [r[0] + 5000, r[1] + 5000, r[2] + 5000, r[3] + 5000])),
        ).toEqual(base);
      }),
      { numRuns: 200 },
    );
  }, 120_000);
});

describe('event identity', () => {
  it('every event in a run has a unique id (ids key idempotent storage)', () => {
    fc.assert(
      fc.property(walk(30, 400), (rows) => {
        const events = run(rows, cfg);
        const seen = new Map<string, string>();
        const dup: string[] = [];
        for (const e of events) {
          const was = seen.get(e.id);
          if (was !== undefined)
            dup.push(`${was} vs ${e.type}:${e.tf}:${e.scale}:${e.anchorOpenTime}`);
          seen.set(e.id, `${e.type}:${e.tf}:${e.scale}:${e.anchorOpenTime}`);
        }
        expect(dup).toEqual([]);
      }),
      { numRuns: 300 },
    );
  }, 120_000);
});
