import type { Scheduler, SocketLike } from '../src/managed-connection.js';

type Listener = (event: never) => void;

export class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closedWith: number | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.closedWith = code;
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: 'open' | 'message' | 'close' | 'error', event: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as (e: object) => void)(event);
  }
  open(): void {
    this.emit('open');
  }
  message(text: string): void {
    this.emit('message', { data: text });
  }
}

/** Manual clock: nothing happens until `advance`. Random is fixed so backoff is exact. */
export class FakeScheduler implements Scheduler {
  private nowMs = 1_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  constructor(private readonly randomValue = 1) {}

  now(): number {
    return this.nowMs;
  }
  random(): number {
    return this.randomValue;
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, fn });
    return () => this.timers.delete(id);
  }
  setInterval(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, fn, every: ms });
    return () => this.timers.delete(id);
  }
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.nowMs = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
    this.nowMs = target;
  }
  get pendingTimers(): number {
    return this.timers.size;
  }
}
