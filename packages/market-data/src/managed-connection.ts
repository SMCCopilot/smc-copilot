import type { FeedStatus } from './provider.js';

/** The slice of the WebSocket API we use, so tests can drive connections without a network. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: 'open', fn: () => void): void;
  addEventListener(type: 'message', fn: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close' | 'error',
    fn: (event: { code?: number; message?: string }) => void,
  ): void;
}
export type SocketFactory = (url: string) => SocketLike;

/** Time and randomness are injected: backoff, rotation and watchdogs are tested with a fake clock. */
export interface Scheduler {
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};

/** Node 22+ ships a WebSocket client (undici); the factory is only touched in production wiring. */
export const defaultSocketFactory: SocketFactory = (url) =>
  new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url);

export interface ManagedConnectionOptions {
  readonly url: string;
  readonly factory: SocketFactory;
  readonly scheduler?: Scheduler;
  onMessage(text: string, receivedAtMs: number): void;
  onStatus(status: FeedStatus, detail?: string): void;
  /** Called on every (re)connect, e.g. to send a subscribe message. */
  onOpen?(send: (text: string) => void): void;
  readonly ping?: { readonly everyMs: number; readonly payload: string };
  /** Open a replacement connection this long after connecting, switch when it delivers, then drop the old one. */
  readonly rotateAfterMs?: number;
  /** A replacement that stays silent this long is abandoned. */
  readonly rotationConfirmMs?: number;
  /** No frame at all for this long means a half-open socket: reconnect. */
  readonly silenceTimeoutMs?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  /** After repeated failures, asked what is wrong (for example a REST probe that sees HTTP 451 -> GEO_BLOCKED). */
  readonly classifyFailure?: () => Promise<FeedStatus | null>;
}

interface Entry {
  socket: SocketLike;
  rotation: boolean;
  gotMessage: boolean;
  dead: boolean;
  intentional: boolean;
  cancelers: (() => void)[];
  cancelSilence?: () => void;
}

const CLASSIFY_AFTER_FAILURES = 3;

/**
 * One venue connection that heals itself (A03 section 3 adapter rules): capped exponential backoff with jitter,
 * a silence watchdog, optional keep-alive pings, and proactive rotation before the venue's connection lifetime
 * ends - the replacement must deliver a frame before the old socket is closed, so rotation leaves no gap.
 */
export class ManagedConnection {
  private readonly clock: Scheduler;
  private active: Entry | null = null;
  private pending: Entry | null = null;
  private closed = false;
  private attempt = 0;
  private failures = 0;
  private everConnected = false;
  private reconnectCancel: (() => void) | null = null;
  private rotateCancel: (() => void) | null = null;
  reconnects = 0;
  lastMessageAtMs: number | null = null;

  constructor(private readonly options: ManagedConnectionOptions) {
    this.clock = options.scheduler ?? realScheduler;
  }

  get connected(): boolean {
    return this.active !== null && !this.active.dead;
  }

  start(): void {
    this.connect(false);
  }

  close(): void {
    this.closed = true;
    this.reconnectCancel?.();
    this.rotateCancel?.();
    for (const entry of [this.active, this.pending]) if (entry) this.retire(entry);
    this.active = null;
    this.pending = null;
  }

  private connect(rotation: boolean): Entry {
    const entry: Entry = {
      socket: this.options.factory(this.options.url),
      rotation,
      gotMessage: false,
      dead: false,
      intentional: false,
      cancelers: [],
    };
    if (rotation) this.pending = entry;
    else this.active = entry;

    const { socket } = entry;
    socket.addEventListener('open', () => {
      this.options.onOpen?.((text) => socket.send(text));
      const ping = this.options.ping;
      if (ping) {
        entry.cancelers.push(
          this.clock.setInterval(() => {
            if (!entry.dead) socket.send(ping.payload);
          }, ping.everyMs),
        );
      }
      if (!rotation) {
        this.options.onStatus(this.everConnected ? 'RECONNECTED' : 'CONNECTED');
        this.everConnected = true;
        this.scheduleRotation();
      }
    });
    socket.addEventListener('message', (event) => {
      if (entry.dead) return;
      const now = this.clock.now();
      this.lastMessageAtMs = now;
      this.armSilence(entry);
      if (!entry.gotMessage) {
        entry.gotMessage = true;
        if (rotation) this.promote(entry);
        else {
          this.attempt = 0;
          this.failures = 0;
        }
      }
      this.options.onMessage(String(event.data), now);
    });
    socket.addEventListener('close', (event) =>
      this.dropped(entry, `closed${event.code ? ` (${event.code})` : ''}`),
    );
    socket.addEventListener('error', (event) =>
      this.dropped(entry, event.message ?? 'socket error'),
    );
    this.armSilence(entry);
    if (rotation) {
      entry.cancelers.push(
        this.clock.setTimeout(() => {
          if (!entry.gotMessage) this.abandonRotation(entry);
        }, this.options.rotationConfirmMs ?? 30_000),
      );
    }
    return entry;
  }

  private armSilence(entry: Entry): void {
    const limit = this.options.silenceTimeoutMs;
    if (!limit) return;
    entry.cancelSilence?.();
    entry.cancelSilence = this.clock.setTimeout(() => {
      if (!entry.dead) this.dropped(entry, 'silent');
    }, limit);
  }

  private retire(entry: Entry): void {
    entry.dead = true;
    for (const cancel of entry.cancelers.splice(0)) cancel();
    entry.cancelSilence?.();
    try {
      entry.socket.close(1000);
    } catch {
      // already closed
    }
  }

  private dropped(entry: Entry, detail: string): void {
    if (entry.dead) return;
    const wasIntentional = entry.intentional;
    this.retire(entry);
    if (this.closed || wasIntentional) return;

    if (entry === this.pending) {
      this.pending = null;
      this.scheduleRotation(60_000);
      return;
    }
    if (entry !== this.active) return;
    this.active = null;
    this.rotateCancel?.();
    this.options.onStatus('DISCONNECTED', detail);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 1000, maxMs: 60_000 };
    const ceiling = Math.min(maxMs, baseMs * 2 ** this.attempt);
    const delay = Math.round(ceiling * (0.5 + this.clock.random() * 0.5));
    this.attempt += 1;
    this.failures += 1;
    this.reconnects += 1;
    this.options.onStatus('RECONNECTING', `in ${delay} ms`);
    if (this.failures >= CLASSIFY_AFTER_FAILURES && this.options.classifyFailure) {
      void this.options.classifyFailure().then((status) => {
        if (status && !this.closed) this.options.onStatus(status);
      });
    }
    this.reconnectCancel = this.clock.setTimeout(() => {
      if (!this.closed) this.connect(false);
    }, delay);
  }

  private scheduleRotation(afterMs = this.options.rotateAfterMs): void {
    this.rotateCancel?.();
    if (!afterMs) return;
    this.rotateCancel = this.clock.setTimeout(() => {
      if (!this.closed && this.active && !this.pending) this.connect(true);
    }, afterMs);
  }

  private promote(entry: Entry): void {
    const old = this.active;
    this.pending = null;
    this.active = entry;
    this.attempt = 0;
    this.failures = 0;
    if (old) {
      old.intentional = true;
      this.retire(old);
    }
    this.options.onStatus('ROTATED');
    this.scheduleRotation();
  }

  private abandonRotation(entry: Entry): void {
    entry.intentional = true;
    this.retire(entry);
    if (this.pending === entry) this.pending = null;
    this.scheduleRotation(60_000);
  }
}
