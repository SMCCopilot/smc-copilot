import { LlmError } from '../errors.js';
import type { ProviderAdapter, ProviderCallArgs, ProviderCallResult } from '../types.js';
import { type FetchLike, num, postJson } from './http.js';

/** Gemini generateContent. */
export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com',
  ) {}

  async call({ apiKey, model, req, signal }: ProviderCallArgs): Promise<ProviderCallResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [
        ...(req.history ?? []).map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.content }],
        })),
        {
          role: 'user',
          parts: [
            ...(req.images ?? []).map((i) => ({
              inlineData: { mimeType: i.mime, data: i.base64 },
            })),
            { text: req.user },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    const json = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': apiKey },
      body,
      signal,
    )) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      usageMetadata?: Record<string, unknown>;
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    if (!text) throw new LlmError('SERVER', 'provider returned no text');
    const u = json.usageMetadata ?? {};
    return {
      text,
      usage: {
        tokensIn: num(u.promptTokenCount),
        // Thinking tokens are billed as output.
        tokensOut: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
        cachedIn: num(u.cachedContentTokenCount),
        cacheWrite: 0,
      },
    };
  }
}
