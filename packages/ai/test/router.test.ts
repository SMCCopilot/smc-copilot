import { describe, expect, it } from 'vitest';
import { AiUnavailableError, LlmError } from '../src/errors.js';
import type { LlmRequest } from '../src/types.js';
import { makeRouter, scripted, state } from './helpers.js';

const REQ: LlmRequest = { system: 's', user: 'u', maxTokens: 100 };

describe('provider selection (owner switches)', () => {
  it('uses only enabled providers, in priority order', async () => {
    const a = scripted('anthropic', ['A']);
    const o = scripted('openai', ['O']);
    const g = scripted('gemini', ['G']);
    const { router } = makeRouter(
      [
        state('anthropic', { enabled: false, priority: 1 }),
        state('openai', { priority: 3 }),
        state('gemini', { priority: 2 }),
      ],
      [a, o, g],
    );
    const r = await router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' });
    expect(r.text).toBe('G');
    expect(a.calls).toHaveLength(0);
    expect(o.calls).toHaveLength(0);
  });

  it('with nothing enabled it throws NO_PROVIDER_ENABLED; enabled but keyless is NOT_CONFIGURED', async () => {
    const off = makeRouter(
      [state('anthropic', { enabled: false })],
      [scripted('anthropic', ['x'])],
    );
    await expect(off.router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' })).rejects.toMatchObject({
      reason: 'NO_PROVIDER_ENABLED',
    });
    const nokey = makeRouter(
      [state('anthropic', { apiKey: undefined })],
      [scripted('anthropic', ['x'])],
    );
    await expect(nokey.router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' })).rejects.toMatchObject(
      {
        reason: 'NOT_CONFIGURED',
      },
    );
    const nomodel = makeRouter([state('openai', { models: {} })], [scripted('openai', ['x'])]);
    await expect(
      nomodel.router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' }),
    ).rejects.toMatchObject({
      reason: 'NOT_CONFIGURED',
    });
  });

  it('picks the fast or strong model by job', async () => {
    const a = scripted('anthropic', ['x']);
    const { router } = makeRouter([state('anthropic')], [a]);
    await router.call('J6_ROUTER', REQ, { dataClass: 'D2' });
    await router.call('J3_CHAT', REQ, { dataClass: 'D2' });
    expect(a.calls.map((c) => c.model)).toEqual(['anthropic-fast', 'anthropic-strong']);
  });
});

describe('data classes', () => {
  it('refuses a provider not allowed for the class and records PROVIDER_BLOCKED_BY_POLICY', async () => {
    const o = scripted('openai', ['x']);
    const { router, records } = makeRouter([state('openai', { dataClasses: ['D0'] })], [o]);
    await expect(router.call('J3_CHAT', REQ, { dataClass: 'D2' })).rejects.toMatchObject({
      reason: 'BLOCKED_BY_POLICY',
    });
    expect(o.calls).toHaveLength(0);
    expect(records[0]?.outcome).toBe('PROVIDER_BLOCKED_BY_POLICY');
  });

  it('skips a disallowed provider and uses the next allowed one', async () => {
    const a = scripted('anthropic', ['A']);
    const o = scripted('openai', ['O']);
    const { router } = makeRouter(
      [state('openai', { priority: 1, dataClasses: ['D0'] }), state('anthropic', { priority: 2 })],
      [a, o],
    );
    const r = await router.call('J3_CHAT', REQ, { dataClass: 'D2' });
    expect(r.provider).toBe('anthropic');
    expect(o.calls).toHaveLength(0);
  });

  it('an image request must be classed D1', async () => {
    const { router } = makeRouter([state('anthropic')], [scripted('anthropic', ['x'])]);
    await expect(
      router.call(
        'J1_IMAGE_READ',
        { ...REQ, images: [{ mime: 'image/png', base64: 'AA==' }] },
        { dataClass: 'D0' },
      ),
    ).rejects.toThrow(/D1/);
  });

  it('an image goes only to a provider allowed D1', async () => {
    const o = scripted('openai', ['x']);
    const { router } = makeRouter([state('openai', { dataClasses: ['D0', 'D2'] })], [o]);
    await expect(
      router.call(
        'J1_IMAGE_READ',
        { ...REQ, images: [{ mime: 'image/png', base64: 'AA==' }] },
        { dataClass: 'D1' },
      ),
    ).rejects.toMatchObject({ reason: 'BLOCKED_BY_POLICY' });
    expect(o.calls).toHaveLength(0);
  });
});

describe('fault injection', () => {
  it('retries once on a 429 honouring retry-after, then succeeds on the same provider', async () => {
    const a = scripted('anthropic', [new LlmError('RATE_LIMITED', 'x', 429, 100), 'ok']);
    const { router, records } = makeRouter([state('anthropic')], [a]);
    const r = await router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' });
    expect(r.text).toBe('ok');
    expect(a.calls).toHaveLength(2);
    expect(records.map((x) => x.outcome)).toEqual(['RATE_LIMITED', 'OK']);
  });

  it('moves down the chain on 5xx and marks the answer degraded', async () => {
    const a = scripted('anthropic', [new LlmError('SERVER', 'x', 503)]);
    const o = scripted('openai', ['from openai']);
    const { router } = makeRouter(
      [state('anthropic', { priority: 1 }), state('openai', { priority: 2 })],
      [a, o],
    );
    const r = await router.call('J3_CHAT', REQ, { dataClass: 'D2' });
    expect(r.provider).toBe('openai');
    expect(r.degraded).toBe(true);
    expect(a.calls).toHaveLength(2);
  });

  it('does not retry an auth failure and moves on', async () => {
    const a = scripted('anthropic', [new LlmError('AUTH', 'x', 401)]);
    const o = scripted('openai', ['ok']);
    const { router } = makeRouter(
      [state('anthropic', { priority: 1 }), state('openai', { priority: 2 })],
      [a, o],
    );
    await router.call('J3_CHAT', REQ, { dataClass: 'D2' });
    expect(a.calls).toHaveLength(1);
  });

  it('a timeout aborts the call and is recorded as TIMEOUT', async () => {
    const slow = {
      id: 'anthropic' as const,
      async call({ signal }: { signal: AbortSignal }) {
        await new Promise((_, rej) =>
          signal.addEventListener('abort', () => rej(new LlmError('TIMEOUT', 't'))),
        );
        return { text: '', usage: { tokensIn: 0, tokensOut: 0, cachedIn: 0, cacheWrite: 0 } };
      },
    };
    const { router, records } = makeRouter([state('anthropic')], [slow], {
      timeoutMs: { J6_ROUTER: 20 },
    });
    await expect(router.call('J6_ROUTER', REQ, { dataClass: 'D2' })).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    expect(records.some((r) => r.outcome === 'TIMEOUT')).toBe(true);
  });

  it('everything failing throws ALL_FAILED', async () => {
    const { router } = makeRouter(
      [state('anthropic')],
      [scripted('anthropic', [new LlmError('SERVER', 'x', 500)])],
    );
    await expect(router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' })).rejects.toMatchObject({
      reason: 'ALL_FAILED',
    });
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures, skips the provider, then half-opens after the cooldown', async () => {
    const bad = scripted('anthropic', [new LlmError('SERVER', 'x', 500)]);
    const good = scripted('openai', ['ok']);
    const { router, advance } = makeRouter(
      [state('anthropic', { priority: 1 }), state('openai', { priority: 2 })],
      [bad, good],
    );
    for (let i = 0; i < 3; i++) await router.call('J3_CHAT', REQ, { dataClass: 'D2' });
    const callsWhenOpen = bad.calls.length;
    await router.call('J3_CHAT', REQ, { dataClass: 'D2' });
    expect(bad.calls.length).toBe(callsWhenOpen); // breaker open: not even tried
    advance(31_000);
    await router.call('J3_CHAT', REQ, { dataClass: 'D2' });
    expect(bad.calls.length).toBe(callsWhenOpen + 1); // one half-open probe
  });
});

describe('cost metering', () => {
  it('records tokens and cost per call from the price table', async () => {
    const { router, records } = makeRouter([state('anthropic')], [scripted('anthropic', ['x'])]);
    const r = await router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' });
    // 1000 in at $3/M + 200 out at $15/M
    expect(r.costUsd).toBeCloseTo(0.006, 6);
    expect(records[0]).toMatchObject({
      job: 'J2_NARRATIVE',
      dataClass: 'D0',
      provider: 'anthropic',
      costUsd: r.costUsd,
    });
  });

  it('an unpriced model is billed at the conservative fallback rate', async () => {
    const { router } = makeRouter([state('gemini')], [scripted('gemini', ['x'])]);
    const r = await router.call('J2_NARRATIVE', REQ, { dataClass: 'D0' });
    expect(r.costUsd).toBeGreaterThan(0.009); // 1000*5 + 200*25 = 0.01
  });
});

import { PriceTable } from '../src/pricing.js';

describe('price table', () => {
  it('bills cache-write tokens once, at their own rate', () => {
    const t = new PriceTable({ m: { in: 3, out: 15 } });
    expect(
      t.cost('m', { tokensIn: 1000, tokensOut: 0, cachedIn: 0, cacheWrite: 1000 }),
    ).toBeCloseTo(0.00375, 6);
    expect(
      t.cost('m', { tokensIn: 1000, tokensOut: 100, cachedIn: 400, cacheWrite: 0 }),
    ).toBeCloseTo((600 * 3 + 400 * 3 + 100 * 15) / 1e6, 6);
  });
});
