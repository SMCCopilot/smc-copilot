'use client';
import type { MarketType, Timeframe } from '@smc/contracts';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import {
  binanceSymbol,
  klinesUrl,
  klineToCandle,
  mergeCandle,
  parseFrame,
  rowToCandle,
  streamUrl,
} from './binance-direct';
import type { CandleRow } from './market';

const KEY = 'smc-live-prices';

/** Whether to show live prices straight from Binance. On by default; the choice is remembered in this browser. */
export const useLivePricePref = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({
  on: (() => {
    try {
      return localStorage.getItem(KEY) !== 'off';
    } catch {
      return true;
    }
  })(),
  set: (on) => {
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {}
    set({ on });
  },
}));

export type PriceState = 'OFF' | 'LOADING' | 'LIVE' | 'RECONNECTING' | 'BLOCKED' | 'ERROR';
export interface LivePrices {
  state: PriceState;
  candles: CandleRow[] | null;
}

/**
 * Candles for one Binance market and timeframe: history over REST, then every update over the venue's WebSocket,
 * reconnecting with a growing pause. 451 and 403 mean Binance refuses the user's region; that is reported plainly.
 */
export function useLivePrices(
  canonical: string | undefined,
  market: MarketType | undefined,
  tf: Timeframe,
  enabled: boolean,
): LivePrices {
  const [data, setData] = useState<LivePrices>({ state: 'OFF', candles: null });

  useEffect(() => {
    const symbol = canonical ? binanceSymbol(canonical) : null;
    if (!enabled || !symbol || !market) {
      setData({ state: 'OFF', candles: null });
      return;
    }
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pause = 1000;
    let pending: CandleRow | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctl = new AbortController();
    setData({ state: 'LOADING', candles: null });

    const flush = () => {
      timer = undefined;
      const c = pending;
      pending = null;
      if (c) setData((d) => ({ state: 'LIVE', candles: mergeCandle(d.candles ?? [], c) }));
    };

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(streamUrl(market, symbol, tf));
      ws.onopen = () => {
        pause = 1000;
        setData((d) => ({ ...d, state: 'LIVE' }));
      };
      ws.onmessage = (e) => {
        const k = parseFrame(String(e.data));
        if (!k) return;
        pending = klineToCandle(k);
        // At most about five redraws a second, however fast the venue sends.
        if (timer === undefined) timer = setTimeout(flush, 200);
      };
      ws.onclose = () => {
        if (closed) return;
        setData((d) => ({ ...d, state: 'RECONNECTING' }));
        retry = setTimeout(
          () => {
            void history().then(connect);
          },
          pause + Math.random() * 500,
        );
        pause = Math.min(pause * 2, 15_000);
      };
    };

    async function history(): Promise<void> {
      try {
        const res = await fetch(klinesUrl(market as MarketType, symbol as string, tf), {
          signal: ctl.signal,
        });
        if (res.status === 451 || res.status === 403) {
          if (!closed) setData({ state: 'BLOCKED', candles: null });
          closed = true;
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const rows = (await res.json()) as unknown[][];
        if (!closed) setData((d) => ({ state: d.state, candles: rows.map((r) => rowToCandle(r)) }));
      } catch {
        if (!closed) setData((d) => (d.candles ? d : { state: 'ERROR', candles: null }));
      }
    }

    void history().then(connect);
    return () => {
      closed = true;
      ctl.abort();
      ws?.close();
      if (retry) clearTimeout(retry);
      if (timer) clearTimeout(timer);
    };
  }, [canonical, market, tf, enabled]);

  return data;
}
