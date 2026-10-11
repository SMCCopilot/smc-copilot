import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SQL_TESTS_DIR } from './migrations.js';

export interface SmokeReport {
  /** Number of `EXPECT ERROR` markers whose statement failed as required. */
  readonly expectedFailuresFired: number;
  /** Number of `EXPECT ERROR` markers in the part of the script that ran. */
  readonly expectedFailuresDeclared: number;
  /** Errors that no marker announced, and markers whose statement did not fail. */
  readonly problems: string[];
  readonly output: string;
}

/**
 * Reads psql output (stdout and stderr in arrival order) from the smoke test and checks that every statement
 * marked `EXPECT ERROR` failed and nothing else did. The script keeps going after an error by design.
 */
export function analyzeSmokeOutput(output: string): SmokeReport {
  const problems: string[] = [];
  let declared = 0;
  let fired = 0;
  let pending: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.includes('EXPECT ERROR')) {
      if (pending !== null) problems.push(`expected failure did not happen: ${pending}`);
      declared += 1;
      pending = line.trim();
      continue;
    }
    if (/\bERROR:/.test(line)) {
      if (pending !== null) {
        fired += 1;
        pending = null;
      } else {
        problems.push(`unexpected error: ${line.trim()}`);
      }
      continue;
    }
    // A new section header closes an unanswered expectation.
    if (/^--- /.test(line) && pending !== null) {
      problems.push(`expected failure did not happen: ${pending}`);
      pending = null;
    }
  }
  if (pending !== null) problems.push(`expected failure did not happen: ${pending}`);

  return { expectedFailuresFired: fired, expectedFailuresDeclared: declared, problems, output };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The smoke test inserts auth.users rows and test data, so it only ever runs against a local database. */
export function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) {
    throw new Error(`refusing to run the SQL smoke test against non-local host "${host}"`);
  }
}

/** Runs `sql-tests/b03_smoke_test.sql` through `psql`, which the script needs for `\echo`, `\gset` and `\if`. */
export function runSmokeTest(databaseUrl: string, psql = 'psql'): Promise<SmokeReport> {
  assertLocalDatabase(databaseUrl);
  const file = join(SQL_TESTS_DIR, 'b03_smoke_test.sql');
  return new Promise((resolve, reject) => {
    // stderr is merged into stdout by the shell so errors stay next to the marker that announced them.
    const child = spawn(`${psql} "${databaseUrl}" -X -q -f "${file}" 2>&1`, { shell: true });
    let output = '';
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => resolve(analyzeSmokeOutput(output)));
  });
}
