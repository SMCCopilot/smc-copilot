export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
export const AUTH_CONFIGURED = SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';
