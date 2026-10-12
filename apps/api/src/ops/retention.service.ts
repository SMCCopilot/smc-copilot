import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Env } from '@smc/config';
import type { Sql } from '@smc/db';
import { ENV, SQL } from '../config/tokens.js';

/**
 * Applies the retention promises (A06 section 10) on a timer: resume log 7 days, voice log 30 days, chat and Explain
 * records 90 days, AI call metadata 90 days (whole monthly partitions), audit trail one year, expired abuse blocks, old
 * idempotency keys and quarantined candles. The work is one SQL function (`retention_purge`), so it is also what a
 * database-only operator would run by hand.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (!this.sql || this.env.RETENTION_INTERVAL_MIN <= 0) return;
    const run = () =>
      this.run().catch((e: unknown) => this.log.error(`retention failed: ${String(e)}`));
    this.first = setTimeout(run, 60_000);
    this.timer = setInterval(run, this.env.RETENTION_INTERVAL_MIN * 60_000);
    this.first.unref();
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  /** Runs one pass and returns what was removed, by kind. */
  async run(): Promise<Record<string, unknown>> {
    if (!this.sql) return {};
    await this.sql`select maintain_partitions(3)`;
    const [row] = await this.sql<{ r: Record<string, unknown> }[]>`select retention_purge() as r`;
    const result = row?.r ?? {};
    this.log.log(`retention pass: ${JSON.stringify(result)}`);
    return result;
  }
}
