'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { API_URL } from './env';
import { ApiError, FRIENDLY } from './errors';
import { createFrameBatcher, createSeqFilter, type LiveState } from './seq';
import { useSelection } from './sessions';

export interface ChangeEntry {
  at: number;
  text: string;
}
interface Live {
  state: LiveState;
  warnings: string[];
  changes: ChangeEntry[];
  error: string | null;
  /** Set when another tab took the session; the user can take it back. */
  takeover: number;
  set: (p: Partial<Live>) => void;
}

export const useLive = create<Live>((set) => ({
  state: 'IDLE',
  warnings: [],
  changes: [],
  error: null,
  takeover: 0,
  set: (p) => set(p),
}));

const REFRESH_EVENTS = new Set([
  'analysis.update',
  'setup.event',
  'narrative.done',
  'engine.revision',
]);
const EVENTS = [
  'session.state',
  'analysis.update',
  'setup.event',
  'narrative.done',
  'engine.revision',
  'feed.status',
  'warning',
  'error',
] as const;

interface Envelope {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

const seqKey = (id: string) => `smc-seq:${id}`;
const loadSeq = (id: string): number => {
  try {
    return Number(sessionStorage.getItem(seqKey(id))) || 0;
  } catch {
    return 0;
  }
};

/** Keeps one socket open for the active session: backoff, resume from the last sequence, drop duplicates. */
export function useLiveSession(sessionId: string | null): void {
  const qc = useQueryClient();
  const takeover = useLive((s) => s.takeover);

  useEffect(() => {
    const { set } = useLive.getState();
    if (!sessionId) {
      set({ state: 'IDLE', warnings: [], changes: [], error: null });
      return;
    }
    let closed = false;
    let stop: (() => void) | undefined;
    set({ state: 'CONNECTING', warnings: [], changes: [], error: null });

    (async () => {
      const { io } = await import('socket.io-client');
      if (closed) return;
      const filter = createSeqFilter(loadSeq(sessionId));
      const flush = createFrameBatcher(
        (cb) => requestAnimationFrame(cb),
        () => {
          for (const k of ['analysis', 'candles', 'events', 'rejected'])
            qc.invalidateQueries({ queryKey: [k] });
        },
      );
      const socket = io(API_URL, {
        path: '/ws',
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30_000,
        randomizationFactor: 0.5,
        // A fresh token on every attempt: the old one may have expired while the network was down.
        auth: (cb) => {
          api<{ wsToken: string }>(`/v1/sessions/${sessionId}/ws-token`, { method: 'POST' }).then(
            (t) => cb({ wsToken: t.wsToken, takeover: takeover > 0 }),
            () => cb({ wsToken: '' }),
          );
        },
      });
      stop = () => socket.disconnect();

      socket.on('connect', () => {
        set({ state: filter.last() > 0 ? 'RESYNCING' : 'CONNECTING', error: null });
        socket.emit('session.start', {
          sessionId,
          ...(filter.last() > 0 ? { lastSeq: filter.last() } : {}),
        });
      });
      socket.on('disconnect', () => {
        if (!closed && useLive.getState().state !== 'TAKEN') set({ state: 'RESYNCING' });
      });
      socket.on('connect_error', (e: Error) => {
        if (e.message === 'SESSION_NOT_ACTIVE') {
          set({ state: 'ENDED' });
          useSelection.getState().set({ sessionId: null, startedAt: null });
          socket.disconnect();
        } else {
          set({ state: 'RESYNCING' });
        }
      });

      for (const type of EVENTS) {
        socket.on(type, (env: Envelope) => {
          if (!filter.accept(env.seq)) return;
          try {
            sessionStorage.setItem(seqKey(sessionId), String(filter.last()));
          } catch {}
          const p = env.payload ?? {};
          if (type === 'session.state') {
            if (p.state === 'ACTIVE')
              set({ state: useLive.getState().state === 'STALE' ? 'STALE' : 'LIVE' });
            if (p.state === 'ENDED') {
              set({ state: 'ENDED' });
              useSelection.getState().set({ sessionId: null, startedAt: null });
            }
          } else if (type === 'feed.status') {
            set({ state: p.state === 'STALE' ? 'STALE' : 'LIVE' });
          } else if (type === 'warning') {
            const code = String(p.code ?? '');
            const w = useLive.getState().warnings;
            if (code && !w.includes(code)) set({ warnings: [...w, code] });
            if (code === 'FEED_STALE') set({ state: 'STALE' });
          } else if (type === 'error') {
            const code = String(p.code ?? '');
            if (code === 'SESSION_CONTROLLER_TAKEN') {
              set({ state: 'TAKEN' });
              socket.disconnect();
            } else {
              const friendly =
                code in FRIENDLY
                  ? FRIENDLY[code as keyof typeof FRIENDLY].message
                  : 'Something went wrong.';
              set({ error: friendly });
            }
          } else if (type === 'setup.event') {
            const s = p.setup as
              | { template?: string; direction?: string; state?: string }
              | undefined;
            const dir = s?.direction === 'SHORT' ? 'Short' : 'Long';
            const line = `${dir} scenario ${s?.template ?? ''} ${p.change === 'NEW' ? 'appeared' : 'updated'}: ${s?.state ?? ''}`;
            set({
              changes: [{ at: Date.now(), text: line }, ...useLive.getState().changes].slice(0, 30),
            });
          }
          if (REFRESH_EVENTS.has(type)) flush(type);
        });
      }
    })().catch((e: unknown) => {
      set({ error: e instanceof ApiError ? e.message : 'Could not open the live connection.' });
    });

    return () => {
      closed = true;
      stop?.();
    };
  }, [sessionId, takeover, qc]);
}
