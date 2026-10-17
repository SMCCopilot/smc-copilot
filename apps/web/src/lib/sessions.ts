'use client';
import type { SessionCreatedSchema, SessionDtoSchema, Timeframe } from '@smc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from './api';
import { createKeyHolder } from './gate';

export interface Selection {
  instrumentId: string | null;
  tf: Timeframe;
  sessionId: string | null;
  startedAt: string | null;
}

const KEY = 'smc-selection';
const initial: Selection = { instrumentId: null, tf: '15m', sessionId: null, startedAt: null };

function load(): Selection {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...initial, ...(JSON.parse(raw) as Partial<Selection>) } : initial;
  } catch {
    return initial;
  }
}

/** The chosen instrument, timeframe and open session. Remembered per browser, never anything sensitive. */
export const useSelection = create<Selection & { set: (p: Partial<Selection>) => void }>(
  (set, get) => ({
    ...initial,
    set: (p) => {
      set(p);
      const { set: _s, ...rest } = get();
      try {
        localStorage.setItem(KEY, JSON.stringify(rest));
      } catch {}
    },
  }),
);

export function restoreSelection(): void {
  useSelection.setState(load());
}

export const useSessions = (enabled: boolean) =>
  useQuery({
    queryKey: ['sessions'],
    enabled,
    queryFn: async (): Promise<SessionDto[]> => {
      const r = await api<{ items: unknown[] }>('/v1/sessions?limit=10');
      const { SessionDtoSchema: S } = await import('@smc/contracts');
      return S.array().parse(r.items);
    },
  });

type SessionDto = ReturnType<typeof SessionDtoSchema.parse>;
const keys = createKeyHolder(() => crypto.randomUUID());

export function useCreateSession() {
  const qc = useQueryClient();
  const sel = useSelection();
  return useMutation({
    mutationFn: async (): Promise<ReturnType<typeof SessionCreatedSchema.parse>> => {
      if (!sel.instrumentId) throw new Error('Pick an instrument first.');
      const { SessionCreatedSchema: C } = await import('@smc/contracts');
      return C.parse(
        await api('/v1/sessions', {
          method: 'POST',
          idempotencyKey: keys.get(`${sel.instrumentId}|${sel.tf}`),
          body: { instrumentId: sel.instrumentId, tf: sel.tf, mode: 'FEED' },
        }),
      );
    },
    onSuccess: (s) => {
      keys.release();
      sel.set({ sessionId: s.sessionId, startedAt: new Date().toISOString() });
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useEndSession() {
  const qc = useQueryClient();
  const sel = useSelection();
  return useMutation({
    mutationFn: async () => {
      if (sel.sessionId) await api(`/v1/sessions/${sel.sessionId}/end`, { method: 'POST' });
    },
    onSuccess: () => {
      sel.set({ sessionId: null, startedAt: null });
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
