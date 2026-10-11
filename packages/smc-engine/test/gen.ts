import { type Candle, TIMEFRAME_MS, type Timeframe } from '@smc/contracts';

/** Small deterministic PRNG so generated datasets (and their golden hashes) never change. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MONDAY_UTC = Date.UTC(2026, 9, 12);
export const GEN_TFS: readonly Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

/**
 * A regime-switching random walk on 5m bars (integer prices), aggregated to 15m/1h/4h/1d. Only complete
 * buckets are emitted. Returned in generation order (NOT close order).
 */
export function genCandles(
  instrumentId: string,
  seed: number,
  bars5m: number,
  start = MONDAY_UTC,
  tfs: readonly Timeframe[] = GEN_TFS,
): Candle[] {
  const rnd = mulberry32(seed);
  const base: Candle[] = [];
  let price = 60_000;
  let drift = 0;
  for (let i = 0; i < bars5m; i++) {
    if (i % 288 === 0) drift = Math.floor((rnd() - 0.5) * 12);
    const o = price;
    const c = Math.max(1000, o + drift + Math.floor((rnd() - 0.5) * 140));
    const h = Math.max(o, c) + Math.floor(rnd() * 60);
    const l = Math.max(1, Math.min(o, c) - Math.floor(rnd() * 60));
    price = c;
    base.push({
      instrumentId,
      tf: '5m',
      openTime: start + i * 300_000,
      o,
      h,
      l,
      c,
      v: 1,
      closed: true,
      providerId: 'gen',
    });
  }
  const out: Candle[] = [];
  for (const tf of tfs) {
    if (tf === '5m') {
      out.push(...base);
      continue;
    }
    const ms = TIMEFRAME_MS[tf];
    const per = ms / 300_000;
    const first = Math.ceil((base[0] as Candle).openTime / ms) * ms;
    for (let t = first; ; t += ms) {
      const from = (t - (base[0] as Candle).openTime) / 300_000;
      if (from + per > base.length) break;
      const slice = base.slice(from, from + per);
      out.push({
        instrumentId,
        tf,
        openTime: t,
        o: (slice[0] as Candle).o,
        h: Math.max(...slice.map((s) => s.h)),
        l: Math.min(...slice.map((s) => s.l)),
        c: (slice[slice.length - 1] as Candle).c,
        v: slice.length,
        closed: true,
        providerId: 'gen',
      });
    }
  }
  return out;
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
