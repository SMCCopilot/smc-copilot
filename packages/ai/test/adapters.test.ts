import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GEMINI_THINKING_HEADROOM, GeminiAdapter } from '../src/adapters/gemini.js';
import type { FetchLike } from '../src/adapters/http.js';
import { OpenAiAdapter } from '../src/adapters/openai.js';
import type { LlmRequest } from '../src/types.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fake(response: unknown, status = 200, retryAfter: string | null = null) {
  const seen: Seen[] = [];
  const f: FetchLike = async (url, init) => {
    seen.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      ok: status < 400,
      status,
      headers: { get: () => retryAfter },
      json: async () => response,
    };
  };
  return { f, seen };
}

const REQ: LlmRequest = {
  system: 'SYS',
  user: 'USER',
  maxTokens: 123,
  json: true,
  history: [
    { role: 'user', content: 'h1' },
    { role: 'assistant', content: 'h2' },
  ],
};
const IMG = { mime: 'image/png' as const, base64: 'AAAA' };
const signal = new AbortController().signal;

describe('anthropic adapter', () => {
  it('builds a Messages request without sampling parameters or prefill, and folds cache tokens into usage', async () => {
    const { f, seen } = fake({
      content: [{ type: 'text', text: '{"a":1}' }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 50,
      },
    });
    const r = await new AnthropicAdapter(f).call({
      apiKey: 'K',
      model: 'm',
      req: { ...REQ, images: [IMG] },
      signal,
    });
    const s = seen[0] as Seen;
    expect(s.url).toBe('https://api.anthropic.com/v1/messages');
    expect(s.headers['x-api-key']).toBe('K');
    expect(s.headers['anthropic-version']).toBe('2023-06-01');
    expect(s.body).not.toHaveProperty('temperature');
    const msgs = s.body.messages as { role: string; content: unknown }[];
    expect(msgs.at(-1)?.role).toBe('user'); // never an assistant prefill
    expect(JSON.stringify(msgs.at(-1))).toContain('"type":"image"');
    expect(r.text).toBe('{"a":1}');
    expect(r.usage).toEqual({ tokensIn: 450, tokensOut: 20, cachedIn: 300, cacheWrite: 50 });
  });
});

describe('openai adapter', () => {
  it('builds a chat request with json mode and an image part', async () => {
    const { f, seen } = fake({
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    });
    const r = await new OpenAiAdapter(f).call({
      apiKey: 'K',
      model: 'm',
      req: { ...REQ, images: [IMG] },
      signal,
    });
    const s = seen[0] as Seen;
    expect(s.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(s.headers.authorization).toBe('Bearer K');
    expect(s.body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(s.body.messages)).toContain('data:image/png;base64,AAAA');
    expect(r.usage).toEqual({ tokensIn: 10, tokensOut: 5, cachedIn: 4, cacheWrite: 0 });
  });
});

describe('gemini adapter', () => {
  it('builds generateContent with system instruction, role mapping and thinking tokens as output', async () => {
    const { f, seen } = fake({
      candidates: [
        { content: { parts: [{ text: 'a' }, { text: 'hidden', thought: true }, { text: 'b' }] } },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 7,
        cachedContentTokenCount: 2,
      },
    });
    const r = await new GeminiAdapter(f).call({
      apiKey: 'K',
      model: 'gem x',
      req: { ...REQ, images: [IMG] },
      signal,
    });
    const s = seen[0] as Seen;
    expect(s.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gem%20x:generateContent',
    );
    expect(s.headers['x-goog-api-key']).toBe('K');
    expect(JSON.stringify(s.body.contents)).toContain('"role":"model"');
    expect(JSON.stringify(s.body.contents)).toContain('inlineData');
    expect((s.body.generationConfig as Record<string, unknown>).responseMimeType).toBe(
      'application/json',
    );
    expect(r.text).toBe('ab');
    expect(r.usage.tokensOut).toBe(12);
  });
});

describe('Gemini thinking headroom', () => {
  it('adds room for thinking tokens to the output cap, and names the finish reason when no text comes back', async () => {
    const ok = fake({ candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: {} });
    await new GeminiAdapter(ok.f).call({
      apiKey: 'K',
      model: 'm',
      req: { ...REQ, maxTokens: 700 },
      signal: new AbortController().signal,
    });
    expect(
      ((ok.seen[0] as Seen).body.generationConfig as Record<string, unknown>).maxOutputTokens,
    ).toBe(700 + GEMINI_THINKING_HEADROOM);
    const empty = fake({
      candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 900 },
    });
    let err: { message: string; usage?: { tokensOut: number } } | undefined;
    try {
      await new GeminiAdapter(empty.f).call({
        apiKey: 'K',
        model: 'm',
        req: REQ,
        signal: new AbortController().signal,
      });
    } catch (e) {
      err = e as { message: string; usage?: { tokensOut: number } };
    }
    expect(err?.message).toMatch(/MAX_TOKENS/);
    // The vendor bills the thinking tokens even though no text came back; the meter must see them.
    expect(err?.usage?.tokensOut).toBe(900);
  });
});

describe('errors', () => {
  it('maps statuses to typed errors without copying the body', async () => {
    for (const [status, kind] of [
      [429, 'RATE_LIMITED'],
      [503, 'SERVER'],
      [401, 'AUTH'],
      [400, 'BAD_REQUEST'],
    ] as const) {
      const { f } = fake({ error: 'secret echo sk-ant-xxxxxxxxxxxxxxxxxxxx' }, status, '2');
      const err = await new AnthropicAdapter(f)
        .call({ apiKey: 'K', model: 'm', req: REQ, signal })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind });
      expect(String((err as Error).message)).not.toContain('sk-ant');
    }
    const { f } = fake({}, 429, '2');
    const e = (await new AnthropicAdapter(f)
      .call({ apiKey: 'K', model: 'm', req: REQ, signal })
      .catch((x: unknown) => x)) as { retryAfterMs: number };
    expect(e.retryAfterMs).toBe(2000);
  });

  it('a network failure and an abort are typed', async () => {
    const boom: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      new OpenAiAdapter(boom).call({ apiKey: 'K', model: 'm', req: REQ, signal }),
    ).rejects.toMatchObject({ kind: 'NETWORK' });
    const ctl = new AbortController();
    ctl.abort();
    const aborted: FetchLike = async () => {
      throw Object.assign(new Error('x'), { name: 'AbortError' });
    };
    await expect(
      new OpenAiAdapter(aborted).call({ apiKey: 'K', model: 'm', req: REQ, signal: ctl.signal }),
    ).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });
});
