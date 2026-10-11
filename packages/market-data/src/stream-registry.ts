import type { Scheduler } from './managed-connection.js';
import { realScheduler } from './managed-connection.js';

export interface StreamHandle {
  stop(): void;
}

/** How a stream for one instrument is started and stopped; the registry only counts holders. */
export interface StreamStarter {
  start(instrumentId: string): StreamHandle;
}

/**
 * Reference-counted ownership of venue streams (A03 section 8.1, MVP single process): one stream per instrument,
 * started by the first holder and stopped a grace period after the last one leaves, so a user who reconnects
 * does not churn the venue connection. Core instruments hold a permanent reference.
 */
export class StreamRegistry {
  private readonly holders = new Map<
    string,
    { count: number; handle: StreamHandle; cancelStop?: () => void }
  >();
  private readonly clock: Scheduler;

  constructor(
    private readonly starter: StreamStarter,
    private readonly lingerMs = 5 * 60_000,
    scheduler?: Scheduler,
  ) {
    this.clock = scheduler ?? realScheduler;
  }

  acquire(instrumentId: string): () => void {
    let entry = this.holders.get(instrumentId);
    if (entry) {
      entry.cancelStop?.();
      delete entry.cancelStop;
      entry.count += 1;
    } else {
      entry = { count: 1, handle: this.starter.start(instrumentId) };
      this.holders.set(instrumentId, entry);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(instrumentId);
    };
  }

  private release(instrumentId: string): void {
    const entry = this.holders.get(instrumentId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    entry.cancelStop = this.clock.setTimeout(() => {
      const current = this.holders.get(instrumentId);
      if (current && current.count === 0) {
        current.handle.stop();
        this.holders.delete(instrumentId);
      }
    }, this.lingerMs);
  }

  isActive(instrumentId: string): boolean {
    return this.holders.has(instrumentId);
  }

  holderCount(instrumentId: string): number {
    return this.holders.get(instrumentId)?.count ?? 0;
  }

  stopAll(): void {
    for (const entry of this.holders.values()) {
      entry.cancelStop?.();
      entry.handle.stop();
    }
    this.holders.clear();
  }
}
