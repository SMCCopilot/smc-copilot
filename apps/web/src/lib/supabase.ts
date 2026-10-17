import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTH_CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL } from './env';

let client: Promise<SupabaseClient> | undefined;

/** Loaded lazily so the SDK stays out of the first-load bundle. The SDK keeps and refreshes the session itself. */
export function getSupabase(): Promise<SupabaseClient> {
  if (!AUTH_CONFIGURED) return Promise.reject(new Error('Sign-in is not configured.'));
  client ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    }),
  );
  return client;
}

export async function getAccessToken(): Promise<string | null> {
  if (!AUTH_CONFIGURED) return null;
  const { data } = await (await getSupabase()).auth.getSession();
  return data.session?.access_token ?? null;
}
