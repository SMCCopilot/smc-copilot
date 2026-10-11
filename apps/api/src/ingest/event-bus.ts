import type { Timeframe } from '@smc/contracts';
import type { FeedState } from '@smc/market-data';

export type BusEvents = {
  /** A candle closed (or was completed by a backfill) and is safe to read from the database. */
  'candle.closed': {
    instrumentId: string;
    canonical: string;
    tf: Timeframe;
    openTime: number;
    /** INCOMPLETE: a minute is missing; consumers treat it as a data-quality warning, never as truth. */
    status: 'CLOSED' | 'INCOMPLETE';
    source: 'live' | 'backfill';
  };
  /** History was filled in: consumers recompute from `fromMs` (A04 section 12). */
  'candle.backfilled': { instrumentId: string; canonical: string; fromMs: number; toMs: number };
  'feed.status': {
    instrumentId: string;
    canonical: string;
    state: FeedState;
    reasons: readonly string[];
  };
  'dq.incident': { instrumentId: string; rule: string; opened: boolean };
};

export type BusEventName = keyof BusEvents;
export type Handler<K extends BusEventName> = (payload: BusEvents[K]) => void | Promise<void>;

/** Seam for Valkey streams at M6 (B02 section 2): handlers must be idempotent. */
export interface EventBus {
  publish<K extends BusEventName>(name: K, payload: BusEvents[K]): void;
  subscribe<K extends BusEventName>(name: K, handler: Handler<K>): () => void;
}

/** Typed in-memory bus. A throwing or rejecting handler is isolated so one consumer cannot break another. */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<BusEventName, Set<Handler<BusEventName>>>();
  /** Called when a handler fails; the default drops the error (callers wire a logger). */
  onHandlerError: (name: BusEventName, error: unknown) => void = () => {};

  publish<K extends BusEventName>(name: K, payload: BusEvents[K]): void {
    for (const handler of this.handlers.get(name) ?? []) {
      try {
        const result = (handler as Handler<K>)(payload);
        if (result instanceof Promise) result.catch((e: unknown) => this.onHandlerError(name, e));
      } catch (error) {
        this.onHandlerError(name, error);
      }
    }
  }

  subscribe<K extends BusEventName>(name: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler as Handler<BusEventName>);
    this.handlers.set(name, set);
    return () => set.delete(handler as Handler<BusEventName>);
  }
}
