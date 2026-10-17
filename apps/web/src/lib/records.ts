'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from './api';

export interface JournalEntry {
  id: string;
  kind: string;
  setupId: string | null;
  tradeId: string | null;
  notes: string | null;
  tags: string[];
  createdAt: string;
}
export interface JournalSummary {
  closedTrades: number;
  openTrades: number;
  setupsShown: number;
  totalR: number | null;
  winRate: number | null;
  winRateReason: 'INSUFFICIENT_HISTORY' | null;
}
export interface TradeRow {
  id: string;
  instrumentId: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number | null;
  exitPrice: number | null;
  size: number | null;
  stopPrice: number | null;
  targets: number[];
  status: 'OPEN' | 'CLOSED';
  closeReason: string | null;
  realizedR: number | null;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
}
export interface NotificationRow {
  id: string;
  type: string;
  payload: unknown;
  read: boolean;
  createdAt: string;
}

export const useJournal = () =>
  useQuery({
    queryKey: ['journal'],
    queryFn: async () => (await api<{ items: JournalEntry[] }>('/v1/journal?limit=50')).items,
  });
export const useJournalSummary = () =>
  useQuery({
    queryKey: ['journal-summary'],
    queryFn: () => api<JournalSummary>('/v1/journal/summary'),
  });

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { notes: string; tags: string[]; setupId?: string }) =>
      api('/v1/journal/notes', { method: 'POST', body: b }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['journal'] });
      qc.invalidateQueries({ queryKey: ['journal-summary'] });
    },
  });
}

export const useTrades = () =>
  useQuery({
    queryKey: ['trades'],
    queryFn: async () => (await api<{ items: TradeRow[] }>('/v1/trades?limit=50')).items,
  });

export function useCloseTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; exitPrice: number; reason: 'TP' | 'SL' | 'MANUAL' }) =>
      api(`/v1/trades/${b.id}/close`, {
        method: 'POST',
        body: { exitPrice: b.exitPrice, reason: b.reason },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trades'] });
      qc.invalidateQueries({ queryKey: ['journal-summary'] });
    },
  });
}

export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: async () =>
      (await api<{ items: NotificationRow[] }>('/v1/notifications?limit=50')).items,
    refetchInterval: 60_000,
  });

export function useReadAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/v1/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

// ---- preferences kept on this device only ------------------------------------------------------------------------

interface Prefs {
  /** When on, the Explain upload is switched off and no picture can be sent to an AI model. */
  neverSendImages: boolean;
  setNeverSendImages: (v: boolean) => void;
}
const PREFS_KEY = 'smc-prefs';
const read = (): boolean => {
  try {
    return (
      (JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { neverSendImages?: boolean })
        .neverSendImages === true
    );
  } catch {
    return false;
  }
};
export const usePrefs = create<Prefs>((set) => ({
  neverSendImages: false,
  setNeverSendImages: (neverSendImages) => {
    set({ neverSendImages });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ neverSendImages }));
    } catch {}
  },
}));
export const restorePrefs = (): void => usePrefs.setState({ neverSendImages: read() });

/** A short sentence for a notification, from its type; the raw payload is never dumped on screen. */
export function notificationText(n: NotificationRow): string {
  const [group, rest] = n.type.split('.');
  const words = (rest ?? group ?? n.type).replaceAll('_', ' ').toLowerCase();
  return group === 'position' ? `Logged trade update: ${words}` : words;
}
