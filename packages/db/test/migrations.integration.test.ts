import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS_DIR, MigrationChecksumError } from '../src/migrations.js';
import { runSmokeTest } from '../src/smoke.js';
import { startTestServer, type TestServer } from '../src/testing.js';

let server: TestServer;
const open: Sql[] = [];
const connect = (url: string): Sql => {
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  open.push(sql);
  return sql;
};

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await Promise.all(open.map((s) => s.end({ timeout: 5 })));
  await server.stop();
});

const tableCount = async (sql: Sql) => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition`;
  return row?.n;
};

describe('MVP schema (migrations 0001-0009 with dev shims)', () => {
  let url: string;
  let sql: Sql;

  beforeAll(async () => {
    url = await server.createDatabase();
    sql = connect(url);
  });

  it('applies every migration once and is idempotent on the second run', async () => {
    const first = await applyMigrations(sql, { withShims: true });
    expect(first.applied).toHaveLength(12);
    const second = await applyMigrations(sql, { withShims: true });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(12);
  });

  it('creates the 55 MVP tables the plan promises (partition children excluded)', async () => {
    expect(await tableCount(sql)).toBe(55);
  });

  it('enables row level security on every public table, partitions included', async () => {
    const rows = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public' and not rowsecurity`;
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  it('has no image, frame or audio column outside the allow-list (invariant 2, schema half)', async () => {
    const allowed = new Set([
      'explain_requests.image_bytes', // size only
      'explain_requests.image_width',
      'explain_requests.image_height',
      'copilot_sessions.frames_sampled', // counter only
    ]);
    const suspicious = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public'
        and (data_type = 'bytea' or column_name ~* '(image|frame|audio|blob|pcm|screenshot|pixel|wav|mp3|webm)')`;
    const unexpected = suspicious
      .map((c) => `${c.table_name}.${c.column_name}`)
      .filter((c) => !allowed.has(c));
    expect(unexpected).toEqual([]);
    expect(suspicious.some((c) => c.data_type === 'bytea')).toBe(false);
  });

  it('records the migrations in smc_meta and keeps that schema out of public', async () => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from smc_meta.migrations`;
    expect(row?.n).toBe(12);
  });

  it('refuses a migration whose content changed after it was applied (forward-only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smc-migrations-'));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, '0009_seed_reference.sql'), '-- tampered\nselect 1;');
      await expect(applyMigrations(sql, { withShims: true, dir })).rejects.toBeInstanceOf(
        MigrationChecksumError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the SQL smoke test: all 15 expected failures fire and nothing else fails', async () => {
    const report = await runSmokeTest(url);
    expect(report.problems).toEqual([]);
    expect(report.expectedFailuresFired).toBe(15);
  });
});

describe('function privileges', () => {
  it('no SECURITY DEFINER function in public can be executed by PUBLIC', async () => {
    const server = await startTestServer();
    try {
      const url = await server.createDatabase();
      const sql = postgres(url, { max: 2 });
      await applyMigrations(sql, { withShims: true });
      const open = await sql<{ proname: string }[]>`
        select p.proname from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.prosecdef
           and (p.proacl is null
                or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`;
      await sql.end({ timeout: 5 });
      expect(open.map((r) => r.proname)).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 120_000);
});

describe('full schema (with upgrade/0010 and upgrade/0011)', () => {
  it('has 62 tables with 0010, passes all 17 expected failures, and accepts the forex migration', async () => {
    const url = await server.createDatabase();
    const sql = connect(url);
    await applyMigrations(sql, { withShims: true, withUpgrade: true });
    expect(await tableCount(sql)).toBe(62);

    const report = await runSmokeTest(url);
    expect(report.problems).toEqual([]);
    expect(report.expectedFailuresFired).toBe(17);

    await expect(
      applyMigrations(sql, { withShims: true, withUpgrade: true, withForex: true }),
    ).resolves.toMatchObject({ applied: ['upgrade/0011_forex_enable.sql'] });
  });
});

describe('concurrent runners', () => {
  it('apply each migration exactly once when two processes race', async () => {
    const url = await server.createDatabase();
    const a = connect(url);
    const b = connect(url);
    const [ra, rb] = await Promise.all([
      applyMigrations(a, { withShims: true }),
      applyMigrations(b, { withShims: true }),
    ]);
    expect(ra.applied.length + rb.applied.length).toBe(12);
    const [row] = await a<{ n: number }[]>`select count(*)::int as n from smc_meta.migrations`;
    expect(row?.n).toBe(12);
  });
});
