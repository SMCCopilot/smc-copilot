import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const file = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/beta/metrics.sql');

/** Splits the weekly review file into its named queries. */
function queries(text) {
  return text
    .split(/^-- name: /m)
    .slice(1)
    .map((block) => {
      const nl = block.indexOf('\n');
      return {
        name: block.slice(0, nl).trim(),
        sql: block
          .slice(nl + 1)
          .replace(/^--.*$/gm, '')
          .trim()
          .replace(/;\s*$/, ''),
      };
    });
}

describe('the weekly review queries', () => {
  const qs = queries(readFileSync(file, 'utf8'));

  it('cover every hypothesis H1 to H8 and the safety checks', () => {
    const names = qs.map((q) => q.name).join('|');
    for (const h of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'SAFETY'])
      expect(names).toContain(h);
  });

  it('are valid against the real schema and are read-only', async () => {
    const { applyMigrations, createClient } = await import('@smc/db');
    const { startTestServer } = await import('@smc/db/testing');
    const server = await startTestServer();
    try {
      const sql = createClient(await server.createDatabase(), { max: 2 });
      await applyMigrations(sql, { withShims: true });
      for (const q of qs) {
        expect(q.sql, q.name).toMatch(/^(with|select)\b/i);
        // Words inside quoted text (for example the event name 'analysis.update') are not statements.
        expect(q.sql.replace(/'[^']*'/g, "''"), q.name).not.toMatch(
          /\b(insert|update|delete|drop|alter|truncate|create)\b/i,
        );
        await expect(sql.unsafe(q.sql), q.name).resolves.toBeDefined();
      }
      // On an empty database the safety query that must return nothing does.
      const unsafe = qs.find((q) => q.name.includes('must have a confirmed gate'));
      expect((await sql.unsafe(unsafe.sql)).length).toBe(0);
      await sql.end({ timeout: 5 });
    } finally {
      await server.stop();
    }
  }, 180_000);
});
