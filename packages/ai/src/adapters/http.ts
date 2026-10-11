import { httpError, LlmError } from '../errors.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** POSTs JSON and returns the parsed body. Network failures and aborts become typed errors; bodies never reach messages. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
      throw new LlmError('TIMEOUT', 'provider call timed out');
    }
    throw new LlmError('NETWORK', 'provider unreachable');
  }
  if (!res.ok) throw httpError(res.status, res.headers.get('retry-after'));
  try {
    return await res.json();
  } catch {
    throw new LlmError('SERVER', 'provider returned an unreadable body');
  }
}

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
