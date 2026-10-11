import { PgBoss } from 'pg-boss';

export interface EnqueueOptions {
  /** At most one queued job per key: re-enqueueing the same work is a no-op. */
  readonly singletonKey?: string;
  readonly startAfterSeconds?: number;
}

/** Seam for BullMQ on Valkey at M6 (B02 section 2): job names and payloads stay the same. */
export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue<T extends object>(name: string, data: T, options?: EnqueueOptions): Promise<void>;
  /** Recurring job (cron, UTC). Re-registering the same name replaces the schedule. */
  schedule(name: string, cron: string, data?: object): Promise<void>;
  process<T extends object>(
    name: string,
    handler: (data: T) => Promise<void>,
    options?: { concurrency?: number },
  ): Promise<void>;
}

/** Durable queue in the same Postgres (pg-boss). Needs a session or direct connection, not the transaction pooler. */
export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly known = new Set<string>();

  constructor(
    connectionString: string,
    private readonly onError: (error: unknown) => void,
  ) {
    this.boss = new PgBoss({ connectionString, max: 4, application_name: 'smc-copilot-jobs' });
    this.boss.on('error', (error) => this.onError(error));
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  private async ensureQueue(name: string): Promise<void> {
    if (this.known.has(name)) return;
    await this.boss.createQueue(name);
    this.known.add(name);
  }

  async enqueue<T extends object>(
    name: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.send(name, data, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  async schedule(name: string, cron: string, data: object = {}): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.schedule(name, cron, data, { tz: 'UTC' });
  }

  async process<T extends object>(
    name: string,
    handler: (data: T) => Promise<void>,
    options: { concurrency?: number } = {},
  ): Promise<void> {
    await this.ensureQueue(name);
    await this.boss.work<T>(name, { localConcurrency: options.concurrency ?? 1 }, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }
}

/** Runs handlers inline, in order. Used by tests and by a database-less development run. */
export class InMemoryJobQueue implements JobQueue {
  readonly enqueued: { name: string; data: object; options?: EnqueueOptions }[] = [];
  private readonly handlers = new Map<string, (data: never) => Promise<void>>();
  private readonly seen = new Set<string>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async enqueue<T extends object>(name: string, data: T, options?: EnqueueOptions): Promise<void> {
    const key = options?.singletonKey ? `${name}:${options.singletonKey}` : null;
    if (key && this.seen.has(key)) return;
    if (key) this.seen.add(key);
    this.enqueued.push({ name, data, ...(options ? { options } : {}) });
  }

  readonly schedules: { name: string; cron: string }[] = [];

  async schedule(name: string, cron: string): Promise<void> {
    this.schedules.push({ name, cron });
  }

  async process<T extends object>(
    name: string,
    handler: (data: T) => Promise<void>,
  ): Promise<void> {
    this.handlers.set(name, handler as (data: never) => Promise<void>);
  }

  /** Test helper: run every queued job for `name` through its handler. */
  async drain(name: string): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no handler registered for ${name}`);
    for (const job of this.enqueued.filter((j) => j.name === name))
      await handler(job.data as never);
    this.enqueued.splice(0, this.enqueued.length, ...this.enqueued.filter((j) => j.name !== name));
  }
}
