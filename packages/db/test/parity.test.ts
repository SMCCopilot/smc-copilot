import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checksum, MIGRATIONS_DIR, SQL_TESTS_DIR, selectMigrations } from '../src/migrations.js';

// docs/plan/set-b/sql is canonical (decision D-002). The copies under packages/db must stay byte-identical
// (ignoring line endings) until a deliberate new migration series starts at 0100.
const CANONICAL = fileURLToPath(new URL('../../../docs/plan/set-b/sql/', import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');

describe('packages/db migrations vs canonical set-b/sql', () => {
  it('finds the canonical directory', () => {
    expect(existsSync(CANONICAL)).toBe(true);
  });

  const cases: [string, string][] = [
    ...readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f): [string, string] => [join(MIGRATIONS_DIR, f), join(CANONICAL, f)]),
    ...readdirSync(join(MIGRATIONS_DIR, 'upgrade')).map((f): [string, string] => [
      join(MIGRATIONS_DIR, 'upgrade', f),
      join(CANONICAL, 'upgrade', f),
    ]),
    [join(MIGRATIONS_DIR, 'dev/0000_dev_shims.sql'), join(CANONICAL, '0000_dev_shims.sql')],
    [join(SQL_TESTS_DIR, 'b03_smoke_test.sql'), join(CANONICAL, 'tests/b03_smoke_test.sql')],
  ];

  it.each(cases)('%s matches the canonical file', (copy, canonical) => {
    expect(checksum(read(copy))).toBe(checksum(read(canonical)));
  });

  it('copies every canonical numbered migration (nothing missing)', () => {
    const canonical = readdirSync(CANONICAL).filter(
      (f) => /^\d{4}_.+\.sql$/.test(f) && f !== '0000_dev_shims.sql',
    );
    const copied = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(copied.sort()).toEqual(canonical.sort());
  });

  it('selects migrations in numeric order with shims first and upgrades last', () => {
    const names = selectMigrations({ withShims: true, withUpgrade: true, withForex: true }).map(
      (m) => m.name,
    );
    expect(names.slice(0, 2)).toEqual([
      'dev/0000_dev_shims.sql',
      'dev/0001_dev_shims_identities.sql',
    ]);
    expect(names.slice(2, 11)).toEqual([...names.slice(2, 11)].sort());
    expect(names.slice(-2)).toEqual([
      'upgrade/0010_full_product_additions.sql',
      'upgrade/0011_forex_enable.sql',
    ]);
  });

  it('does not select shims or upgrades unless asked (shims must never reach Supabase by default)', () => {
    const names = selectMigrations().map((m) => m.name);
    expect(names.some((n) => n.startsWith('dev/') || n.startsWith('upgrade/'))).toBe(false);
    expect(names).toHaveLength(12);
  });
});
