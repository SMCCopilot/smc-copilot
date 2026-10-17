import { toApiError } from './errors';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}
