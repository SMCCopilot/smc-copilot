'use client';
import type { SessionCreatedSchema, SessionDtoSchema, Timeframe } from '@smc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
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
    onError: () => {
      // "Session limit reached" means a live session exists that this tab does not know about: reload the list so
      // the room can pick it up.
      qc.invalidateQueries({ queryKey: ['sessions'] });
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
    onSuccess: async () => {
      // Refresh the list first: clearing the selection while the old list still shows this session as live would
      // make the room adopt it again.
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      sel.set({ sessionId: null, startedAt: null });
    },
  });
}

/**
 * Picks up the account's live session when this browser has none selected (after a reload, in another tab, or when
 * the remembered one has ended). Without it the room looks empty while the server refuses a new session with
 * "session limit reached".
 */
export function useAdoptLiveSession(sessions: ReturnType<typeof useSessions>): void {
  const sel = useSelection();
  const list = sessions.data;
  const fetching = sessions.isFetching;
  useEffect(() => {
    if (!list || fetching) return;
    const known = sel.sessionId ? list.find((s) => s.id === sel.sessionId) : undefined;
    if (known && known.state !== 'ENDED') return;
    const live = list.find((s) => s.state !== 'ENDED');
    if (live) {
      sel.set({
        sessionId: live.id,
        startedAt: live.startedAt,
        instrumentId: live.instrumentId,
        tf: live.tf ?? sel.tf,
      });
    } else if (known) {
      sel.set({ sessionId: null, startedAt: null });
    }
  }, [list, fetching, sel]);
}
