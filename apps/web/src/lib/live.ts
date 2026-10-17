'use client';
import type { ClientEventType } from '@smc/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { api } from './api';
import { applyChatEvent, applyNarrative, say, useChat } from './chat';
import { API_URL } from './env';
import { ApiError, FRIENDLY } from './errors';
import type { InstrumentDto } from './queries';
import { createFrameBatcher, createSeqFilter, type LiveState } from './seq';
import { useSelection } from './sessions';
import { useUi } from './ui';

export interface ChangeEntry {
  at: number;
  text: string;
}
interface Live {
  state: LiveState;
  warnings: string[];
  changes: ChangeEntry[];
  error: string | null;
  /** Bumped when the user takes the session back from another tab. */
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

let current: Socket | null = null;
/** Sends a client event over the live socket. False when there is no open connection. */
export function emitEvent(type: ClientEventType, payload: unknown): boolean {
  if (!current?.connected) return false;
  current.emit(type, payload);
  return true;
}

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
  'context.updated',
  'voice.final',
  'chat.chunk',
  'chat.done',
  'chat.retract',
  'budget.update',
  'explain.stage',
  'explain.chunk',
  'explain.done',
] as const;

interface Envelope {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

const WARNING_TEXT: Record<string, string> = {
  FEED_MISMATCH:
    'The chart you shared does not match this market’s live data. Pick the right market from the list.',
  LOW_OCR_CONFIDENCE: 'The chart text was hard to read. Try a larger or clearer chart.',
  VENUE_CHANGED: 'The venue on your chart changed.',
  APPROX_MODE: 'No live data for this chart, so the explanation is approximate.',
  STALE_IMAGE: 'That image looks old.',
  AI_DEGRADED: 'AI is running in a reduced mode.',
  BUDGET_SOFT_LIMIT: 'You are close to today’s AI budget.',
  CAPTURE_LOST: 'Screen sharing stopped.',
};

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
    useChat.getState().reset();
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
      current = socket;
      stop = () => {
        socket.disconnect();
        if (current === socket) current = null;
      };

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
            if (code && !w.includes(code)) {
              set({ warnings: [...w, code] });
              if (WARNING_TEXT[code]) say(WARNING_TEXT[code]);
            }
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
              say(friendly);
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
          } else if (type === 'narrative.done') {
            applyNarrative(p as never);
          } else if (type === 'context.updated') {
            const items = qc.getQueryData<{ items: InstrumentDto[] }>(['instruments'])?.items;
            const inst = items?.find((i) => i.canonical === p.instrumentId);
            const tf = p.tf as never;
            useSelection
              .getState()
              .set({ ...(inst ? { instrumentId: inst.id } : {}), ...(tf ? { tf } : {}) });
          } else if (type === 'voice.final') {
            handleVoice(p);
          } else {
            applyChatEvent(type, p);
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

/** Carries out the parts of a spoken command that belong to the browser. Voice never confirms or logs anything. */
function handleVoice(p: Record<string, unknown>): void {
  const ui = useUi.getState();
  if (p.needsPick) say('I was not sure which market you meant. Pick it from the list at the top.');
  if (typeof p.setupId === 'string') ui.chooseSetup(p.setupId);
  if (p.command === 'EXPLAIN_CHART') ui.setExplainOpen(true);
  if (p.command === 'PAUSE_RESUME') say('Session paused or resumed by voice.');
}
