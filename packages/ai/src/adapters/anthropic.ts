import { LlmError } from '../errors.js';
import type { ProviderAdapter, ProviderCallArgs, ProviderCallResult } from '../types.js';
import { type FetchLike, num, postJson } from './http.js';

/** Anthropic Messages API. No sampling parameters and no assistant prefill (newer models reject both). */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async call({ apiKey, model, req, signal }: ProviderCallArgs): Promise<ProviderCallResult> {
    const userContent: unknown[] = [
      ...(req.images ?? []).map((i) => ({
        type: 'image',
        source: { type: 'base64', media_type: i.mime, data: i.base64 },
      })),
      { type: 'text', text: req.user },
    ];
    const body = {
      model,
      max_tokens: req.maxTokens,
      // The static prefix is cached; the dynamic facts and the user's message are not.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [
        ...(req.history ?? []).map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userContent },
      ],
    };
    const json = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
      signal,
    )) as { content?: { type?: string; text?: string }[]; usage?: Record<string, unknown> };
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    if (!text) throw new LlmError('SERVER', 'provider returned no text');
    const u = json.usage ?? {};
    const cachedIn = num(u.cache_read_input_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    return {
      text,
      // Anthropic reports cached tokens separately from input_tokens; fold them into the input total.
      usage: {
        tokensIn: num(u.input_tokens) + cachedIn + cacheWrite,
        tokensOut: num(u.output_tokens),
        cachedIn,
        cacheWrite,
      },
    };
  }
}
