'use client';
import type { Timeframe } from '@smc/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { emitEvent } from './live';
import { useInstruments } from './queries';
import { isAutoStartOff, useCreateSession, useSelection, useSessions } from './sessions';
import { prepareSpeech, shouldPrefetch } from './speech-loader';

const DEFAULT_MARKET = 'BINANCE:PERP:BTCUSDT';

/**
 * Opens the room ready to use: picks a market when none is chosen (BTC perpetual, else the first one), and starts the
 * analysis session by itself when the account has none. Users never have to know what a "session" is.
 */
export function useAutoRoom(): void {
  const sel = useSelection();
  const inst = useInstruments();
  const sessions = useSessions(true);
  const create = useCreateSession();
  const started = useRef(false);

  useEffect(() => {
    const items = inst.data?.items;
    if (!items?.length || sel.instrumentId) return;
    const pick = items.find((i) => i.canonical === DEFAULT_MARKET) ?? items[0];
    if (pick) sel.set({ instrumentId: pick.id });
  }, [inst.data, sel]);

  useEffect(() => {
    if (isAutoStartOff() || started.current || create.isPending) return;
    if (!sel.instrumentId || sel.sessionId || !sessions.data || sessions.isFetching) return;
    if (sessions.data.some((s) => s.state !== 'ENDED')) return; // the adopt hook picks it up
    started.current = true;
    create.mutate(undefined, { onSettled: () => (started.current = false) });
  }, [sel.instrumentId, sel.sessionId, sessions.data, sessions.isFetching, create]);
}

/** Changes the market and/or timeframe at any time: the live session follows (no "end the session first"). */
export function useChangeMarket() {
  const sel = useSelection();
  const inst = useInstruments(false);
  return useCallback(
    (p: { instrumentId?: string; tf?: Timeframe }) => {
      const instrumentId = p.instrumentId ?? sel.instrumentId;
      const tf = p.tf ?? sel.tf;
      sel.set({ instrumentId, tf });
      const canonical = inst.data?.items.find((i) => i.id === instrumentId)?.canonical;
      if (sel.sessionId && canonical) {
        emitEvent('context.set', { instrumentId: canonical, tf, source: 'manual' });
      }
    },
    [sel, inst.data],
  );
}

/**
 * Starts getting voice ready a few seconds after the app opens, so nobody waits when they first press the mic. Skipped
 * on data-saver and slow mobile links, where it waits for the first press instead.
 */
export function useSpeechPrefetch(): void {
  useEffect(() => {
    if (!shouldPrefetch()) return;
    const t = setTimeout(() => void prepareSpeech(), 2500);
    return () => clearTimeout(t);
  }, []);
}
