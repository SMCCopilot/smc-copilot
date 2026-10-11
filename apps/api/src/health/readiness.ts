import { Inject, Injectable } from '@nestjs/common';
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
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  async report(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map(async (check) => {
        try {
          await withTimeout(check.run(), CHECK_TIMEOUT_MS);
          return [check.name, 'ok'] as const;
        } catch {
          return [check.name, 'fail'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results) as Record<string, 'ok' | 'fail'>;
    return { ready: results.every(([, status]) => status === 'ok'), checks };
  }
}
