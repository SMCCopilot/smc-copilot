import { API_URL } from './env';
import { toApiError } from './errors';
import { getAccessToken } from './supabase';

export { API_URL };

interface Opts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** Pass the same key on a retry of the same user action so the server replays instead of repeating it. */
  idempotencyKey?: string;
  auth?: boolean;
}

export async function api<T = void>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.auth !== false) {
    const token = await getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
