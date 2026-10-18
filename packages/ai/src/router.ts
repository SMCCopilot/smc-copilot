import { randomUUID } from 'node:crypto';
import { type BreakerOptions, CircuitBreaker, DEFAULT_BREAKER } from './breaker.js';
import { AiUnavailableError, LlmError, type LlmErrorKind } from './errors.js';
import type { PriceTable } from './pricing.js';
import {
  type CallOutcome,
  type CallRecord,
  type DataClass,
  JOB_TIER,
  JOB_TIMEOUT_MS,
  type JobId,
  type LlmRequest,
  type LlmUsage,
  type ModelTier,
  type ProviderAdapter,
  type ProviderId,
  type ProviderSource,
  type ProviderState,
} from './types.js';

export interface RouterOptions {
  source: ProviderSource;
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  prices: PriceTable;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  /** Called once per provider attempt (success or failure), for the `ai_calls` ledger. */
  onCall?: (r: CallRecord) => void | Promise<void>;
  /** Called when a later check (guardrails) changes the outcome of a recorded call. */
  onOutcome?: (callId: string, outcome: CallOutcome, detail?: string) => void | Promise<void>;
  timeoutMs?: Partial<Record<JobId, number>>;
  breaker?: BreakerOptions;
}

export interface LlmResult {
  text: string;
  provider: ProviderId;
  model: string;
  usage: LlmUsage;
  costUsd: number;
  latencyMs: number;
  callId: string;
  /** A provider other than the owner's first choice answered. */
  degraded: boolean;
}

const ZERO: LlmUsage = { tokensIn: 0, tokensOut: 0, cachedIn: 0, cacheWrite: 0 };
const OUTCOME_OF: Record<LlmErrorKind, CallOutcome> = {
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  SERVER: 'ERROR',
  NETWORK: 'ERROR',
  AUTH: 'ERROR',
  BAD_REQUEST: 'ERROR',
};

/**
 * Sends a job to the enabled providers in the owner's order (A05 section 10). It refuses any provider that is not
 * allowed for the request's data class, retries once on transient failures, moves down the chain on failure, and
 * opens a per-provider breaker when one keeps failing. With nothing usable it throws, and callers use templates.
 */
export class LlmRouter {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: RouterOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private breakerFor(key: string): CircuitBreaker {
    let b = this.breakers.get(key);
    if (!b) {
      b = new CircuitBreaker(this.now, this.o.breaker ?? DEFAULT_BREAKER);
      this.breakers.set(key, b);
    }
    return b;
  }

  /** Breaker state per provider and model, for monitoring. */
  breakerStates(): { provider: string; model: string; state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' }[] {
    return [...this.breakers].map(([key, b]) => {
      const [provider = '', ...rest] = key.split(':');
      return { provider, model: rest.join(':'), state: b.current };
    });
  }

  /** `detail` is a short, content-free reason (for example "number" or "schema"), stored as the call's error code. */
  async markOutcome(callId: string, outcome: CallOutcome, detail?: string): Promise<void> {
    await this.o.onOutcome?.(callId, outcome, detail);
  }

  async call(
    job: JobId,
    req: LlmRequest,
    opts: { dataClass: DataClass; tier?: ModelTier },
  ): Promise<LlmResult> {
    if ((req.images?.length ?? 0) > 0 && opts.dataClass !== 'D1') {
      throw new Error('a request that carries an image must be classed D1');
    }
    const tier = opts.tier ?? JOB_TIER[job];
    const all = [...(await this.o.source.providers())].sort((a, b) => a.priority - b.priority);
    const enabled = all.filter((p) => p.enabled);
    const usable = enabled.filter((p) => p.apiKey && p.models[tier] && this.o.adapters[p.id]);
    if (usable.length === 0) {
      throw new AiUnavailableError(enabled.length > 0 ? 'NOT_CONFIGURED' : 'NO_PROVIDER_ENABLED');
    }
    const allowed = usable.filter((p) => p.dataClasses.includes(opts.dataClass));
    if (allowed.length === 0) {
      const first = usable[0] as ProviderState;
      await this.record({
        id: randomUUID(),
        job,
        dataClass: opts.dataClass,
        provider: first.id,
        model: first.models[tier] as string,
        usage: ZERO,
        costUsd: 0,
        latencyMs: 0,
        outcome: 'PROVIDER_BLOCKED_BY_POLICY',
      });
      throw new AiUnavailableError('BLOCKED_BY_POLICY');
    }

    const attempts: { provider: ProviderId; kind: LlmErrorKind | 'BREAKER_OPEN' }[] = [];
    const timeoutMs = this.o.timeoutMs?.[job] ?? JOB_TIMEOUT_MS[job];
    for (const p of allowed) {
      const model = p.models[tier] as string;
      const adapter = this.o.adapters[p.id] as ProviderAdapter;
      const breaker = this.breakerFor(`${p.id}:${model}`);
      if (!breaker.allow()) {
        attempts.push({ provider: p.id, kind: 'BREAKER_OPEN' });
        continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        // A retry only goes ahead if the breaker still allows it (a failed half-open probe re-opens it).
        if (attempt > 0 && !breaker.allow()) break;
        const started = this.now();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          const r = await adapter.call({
            apiKey: p.apiKey as string,
            model,
            req,
            signal: ctl.signal,
          });
          clearTimeout(timer);
          breaker.success();
          const costUsd = this.o.prices.cost(model, r.usage);
          const latencyMs = this.now() - started;
          const callId = randomUUID();
          await this.record({
            id: callId,
            job,
            dataClass: opts.dataClass,
            provider: p.id,
            model,
            usage: r.usage,
            costUsd,
            latencyMs,
            outcome: 'OK',
          });
          return {
            text: r.text,
            provider: p.id,
            model,
            usage: r.usage,
            costUsd,
            latencyMs,
            callId,
            degraded: p.id !== (usable[0] as ProviderState).id,
          };
        } catch (e) {
          clearTimeout(timer);
          const err =
            e instanceof LlmError
              ? e
              : ctl.signal.aborted
                ? new LlmError('TIMEOUT', 'provider call timed out')
                : new LlmError('SERVER', 'unexpected provider failure');
          breaker.failure();
          attempts.push({ provider: p.id, kind: err.kind });
          // A call that timed out may still have been read (and billed) by the vendor: count the input we sent.
          const failedUsage: LlmUsage =
            err.usage ??
            (err.kind === 'TIMEOUT'
              ? { ...ZERO, tokensIn: Math.ceil((req.system.length + req.user.length) / 4) }
              : ZERO);
          await this.record({
            id: randomUUID(),
            job,
            dataClass: opts.dataClass,
            provider: p.id,
            model,
            usage: failedUsage,
            costUsd: this.o.prices.cost(model, failedUsage),
            latencyMs: this.now() - started,
            outcome: OUTCOME_OF[err.kind],
            // Kind plus the adapter's own short message (never a vendor body), so a failure can be diagnosed.
            errorCode: `${err.kind}:${err.message}`.slice(0, 120),
          });
          if (err.retryable && attempt === 0) {
            const wait = Math.min(
              err.retryAfterMs ?? 250 + (this.o.jitter ?? Math.random)() * 250,
              2000,
            );
            await this.sleep(wait);
            continue;
          }
          break;
        }
      }
    }
    throw new AiUnavailableError('ALL_FAILED', attempts);
  }

  private async record(r: CallRecord): Promise<void> {
    try {
      await this.o.onCall?.(r);
    } catch {
      // The ledger must never break an answer; the caller's meter reports its own failures.
    }
  }
}
