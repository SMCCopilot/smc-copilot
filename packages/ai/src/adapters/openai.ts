import { LlmError } from '../errors.js';
import type { ProviderAdapter, ProviderCallArgs, ProviderCallResult } from '../types.js';
import { type FetchLike, num, postJson } from './http.js';

/** OpenAI Chat Completions. */
export class OpenAiAdapter implements ProviderAdapter {
  readonly id = 'openai' as const;
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = 'https://api.openai.com',
  ) {}

  async call({ apiKey, model, req, signal }: ProviderCallArgs): Promise<ProviderCallResult> {
    const images = req.images ?? [];
    const userContent =
      images.length > 0
        ? [
            ...images.map((i) => ({
              type: 'image_url',
              image_url: { url: `data:${i.mime};base64,${i.base64}` },
            })),
            { type: 'text', text: req.user },
          ]
        : req.user;
    const body = {
      model,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        ...(req.history ?? []).map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userContent },
      ],
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    };
    const json = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/chat/completions`,
      { authorization: `Bearer ${apiKey}` },
      body,
      signal,
    )) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    if (!text) throw new LlmError('SERVER', 'provider returned no text');
    return {
      text,
      usage: {
        tokensIn: num(json.usage?.prompt_tokens),
        tokensOut: num(json.usage?.completion_tokens),
        cachedIn: num(json.usage?.prompt_tokens_details?.cached_tokens),
        cacheWrite: 0,
      },
    };
  }
}
