import { GeoBlockedError, RateLimitedError } from './provider.js';

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export const defaultFetch: FetchLike = (url, init) =>
  (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);

/** Token bucket for a venue's request weight (A03 section 8.2). Time is injected so it can be tested. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Waits until `weight` tokens are available, then takes them. */
  async take(weight: number): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((t - this.last) / 1000) * this.refillPerSec,
      );
      this.last = t;
      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }
      await this.sleep(Math.ceil(((weight - this.tokens) / this.refillPerSec) * 1000));
    }
  }
}

export interface GetJsonOptions {
  readonly fetchImpl: FetchLike;
  readonly limiter?: TokenBucket | undefined;
  readonly weight?: number;
  readonly timeoutMs?: number;
}

/** GET + JSON with the failure classes the callers care about. The URL is never logged with a body. */
export async function getJson(url: string, options: GetJsonOptions): Promise<unknown> {
  await options.limiter?.take(options.weight ?? 1);
  const res = await options.fetchImpl(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (res.status === 451 || res.status === 403) throw new GeoBlockedError(res.status);
  if (res.status === 429 || res.status === 418) {
    const retry = Number(res.headers.get('retry-after'));
    throw new RateLimitedError(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000);
  }
  if (!res.ok) throw new Error(`venue returned HTTP ${res.status}`);
  return res.json();
}
