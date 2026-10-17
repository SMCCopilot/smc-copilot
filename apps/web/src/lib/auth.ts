'use client';
import type { MeResponse } from '@smc/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';
import { AUTH_CONFIGURED } from './env';
import { getSupabase } from './supabase';

export type AuthState = 'loading' | 'out' | 'in';

/** Mirrors the Supabase session (refreshed by the SDK). Tokens stay inside the SDK; only the state is exposed. */
export function useAuthState(): AuthState {
  const qc = useQueryClient();
  const [state, setState] = useState<AuthState>(AUTH_CONFIGURED ? 'loading' : 'out');
  useEffect(() => {
    if (!AUTH_CONFIGURED) return;
    let unsub: (() => void) | undefined;
    let live = true;
    getSupabase().then(async (sb) => {
      const { data } = await sb.auth.getSession();
      if (live) setState(data.session ? 'in' : 'out');
      const sub = sb.auth.onAuthStateChange((_e, s) => {
        setState(s ? 'in' : 'out');
        if (!s) qc.clear();
      });
      unsub = () => sub.data.subscription.unsubscribe();
    });
    return () => {
      live = false;
      unsub?.();
    };
  }, [qc]);
  return state;
}

export const useMe = (enabled: boolean) =>
  useQuery({
    queryKey: ['me'],
    enabled,
    queryFn: async (): Promise<MeResponse> => {
      const { MeResponseSchema } = await import('@smc/contracts');
      return MeResponseSchema.parse(await api('/v1/me'));
    },
  });

export async function signOut(): Promise<void> {
  await (await getSupabase()).auth.signOut();
}
