import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Sql } from '@smc/db';
import { READINESS_CHECKS, SQL } from '../config/tokens.js';

export interface ReadinessCheck {
  readonly name: string;
  /** Resolves when healthy, rejects (or hangs past the timeout) when not. */
  run(): Promise<void>;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Record<string, 'ok' | 'fail'>;
}

const CHECK_TIMEOUT_MS = 2000;
/** One evaluation serves every caller within this window, so /readyz cannot be used to load the database. */
const CACHE_MS = 1000;

const withTimeout = (work: Promise<void>, ms: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * Database reachability plus the pooler self-test (B02 section 9): a parameterised query must work with
 * `prepare: false`, which is exactly what fails when the client is mis-configured for the transaction pooler.
 */
@Injectable()
export class DbReadinessCheck implements ReadinessCheck {
  readonly name = 'database';

  constructor(@Inject(SQL) private readonly sql: Sql | null) {}

  async run(): Promise<void> {
    if (!this.sql) throw new Error('DATABASE_URL is not configured');
    const [row] = await this.sql<{ n: number }[]>`select ${1}::int as n`;
    if (row?.n !== 1) throw new Error('self-test query returned an unexpected result');
  }
}

@Injectable()
export class ReadinessService {
  private readonly log = new Logger(ReadinessService.name);
  private inFlight: Promise<ReadinessReport> | null = null;
  private last: { at: number; report: ReadinessReport } | null = null;

  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  /** Single-flight with a short cache: concurrent and repeated probes share one evaluation. */
  report(): Promise<ReadinessReport> {
    if (this.last && Date.now() - this.last.at < CACHE_MS) return Promise.resolve(this.last.report);
    if (!this.inFlight) {
      this.inFlight = this.evaluate()
        .then((report) => {
          this.last = { at: Date.now(), report };
          return report;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async evaluate(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map(async (check) => {
        try {
          await withTimeout(check.run(), CHECK_TIMEOUT_MS);
          return [check.name, 'ok'] as const;
        } catch (error) {
          // Operators need to know why; callers only ever see "fail". Name and error class, never the message.
          this.log.warn(
            `readiness check "${check.name}" failed: ${(error as Error)?.constructor?.name}`,
          );
          return [check.name, 'fail'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results) as Record<string, 'ok' | 'fail'>;
    return { ready: results.every(([, status]) => status === 'ok'), checks };
  }
}
