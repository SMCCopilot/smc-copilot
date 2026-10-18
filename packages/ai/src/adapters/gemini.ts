import { LlmError } from '../errors.js';
import type { ProviderAdapter, ProviderCallArgs, ProviderCallResult } from '../types.js';
import { type FetchLike, num, postJson } from './http.js';

/**
 * Thinking models spend part of `maxOutputTokens` on thoughts before the visible answer. Seen live on staging: with the
 * plain cap, answers came back empty or cut off mid-JSON and every narrative fell back to the template. The extra room
 * only pays for thinking actually used; the visible answer is still limited by the prompt and the output checks.
 */
export const GEMINI_THINKING_HEADROOM = 2048;

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
        maxOutputTokens: req.maxTokens + GEMINI_THINKING_HEADROOM,
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
      candidates?: {
        content?: { parts?: { text?: string; thought?: boolean }[] };
        finishReason?: string;
      }[];
      usageMetadata?: Record<string, unknown>;
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    const u = json.usageMetadata ?? {};
    const usage = {
      tokensIn: num(u.promptTokenCount),
      // Thinking tokens are billed as output.
      tokensOut: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
      cachedIn: num(u.cachedContentTokenCount),
      cacheWrite: 0,
    };
    if (!text) {
      const why = json.candidates?.[0]?.finishReason;
      throw new LlmError(
        'SERVER',
        `provider returned no text${why ? ` (${why})` : ''}`,
        undefined,
        undefined,
        usage,
      );
    }
    return { text, usage };
  }
}
