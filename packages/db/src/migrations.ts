import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

/** `packages/db/migrations`, resolved from both `src/` (tsx) and `dist/` (built). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
export const SQL_TESTS_DIR = fileURLToPath(new URL('../sql-tests/', import.meta.url));

export interface MigrationFile {
  /** Path relative to the migrations directory, e.g. `0001_identity.sql` or `upgrade/0010_full_product_additions.sql`. */
  readonly name: string;
  readonly sha256: string;
  readonly sql: string;
}

export interface ApplyOptions {
  /** Local/CI only: fakes `auth.users` and `auth.uid()`. Never against Supabase, which provides both. */
  readonly withShims?: boolean;
  /** `upgrade/0010`: Set A tables the MVP omits (milestone M6). */
  readonly withUpgrade?: boolean;
  /** `upgrade/0011`: forex enablement (milestone M10-B, after gate G7). */
  readonly withForex?: boolean;
  /** Directory to read from; defaults to this package's `migrations/`. */
  readonly dir?: string;
}

/** Hash of the file with line endings normalised, so a Windows checkout and a Linux checkout agree. */
export function checksum(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

function readMigration(dir: string, name: string): MigrationFile {
  const sql = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
  return { name, sha256: checksum(sql), sql };
}

/** The ordered list of migration files that `options` selects. */
export function selectMigrations(options: ApplyOptions = {}): MigrationFile[] {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const core = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const names: string[] = [];
  if (options.withShims) names.push('dev/0000_dev_shims.sql');
  names.push(...core);
  if (options.withUpgrade) names.push('upgrade/0010_full_product_additions.sql');
  if (options.withForex) names.push('upgrade/0011_forex_enable.sql');
  return names.map((n) => readMigration(dir, n));
}

export class MigrationChecksumError extends Error {
  constructor(
    readonly migration: string,
    readonly applied: string,
    readonly current: string,
  ) {
    super(
      `migration ${migration} was already applied with a different checksum; migrations are forward-only, add a new numbered migration instead`,
    );
    this.name = 'MigrationChecksumError';
  }
}

export interface ApplyResult {
  readonly applied: string[];
  readonly skipped: string[];
}

const LOCK_KEY = 'smc_meta.migrations';

/**
 * Applies pending migrations in order, each in its own transaction together with its bookkeeping row.
 * Already-applied files are skipped; a changed file is an error (forward-only). Safe to call concurrently:
 * an advisory transaction lock serialises runners. Use a session or direct connection (A01 section 5.2).
 */
export async function applyMigrations(sql: Sql, options: ApplyOptions = {}): Promise<ApplyResult> {
  // `create ... if not exists` is not safe against a concurrent runner on its own, so bootstrap under the lock too.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
    await tx.unsafe(`
      create schema if not exists smc_meta;
      create table if not exists smc_meta.migrations (
        name       text primary key,
        sha256     text not null,
        applied_at timestamptz not null default now()
      );
    `);
  });

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of selectMigrations(options)) {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
      const [existing] = await tx<{ sha256: string }[]>`
        select sha256 from smc_meta.migrations where name = ${migration.name}`;
      if (existing) {
        if (existing.sha256 !== migration.sha256) {
          throw new MigrationChecksumError(migration.name, existing.sha256, migration.sha256);
        }
        skipped.push(migration.name);
        return;
      }
      await tx.unsafe(migration.sql);
      await tx`insert into smc_meta.migrations (name, sha256) values (${migration.name}, ${migration.sha256})`;
      applied.push(migration.name);
    });
  }
  return { applied, skipped };
}
