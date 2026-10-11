import { describe, expect, it } from 'vitest';
import { analyzeSmokeOutput, assertLocalDatabase } from '../src/smoke.js';

describe('analyzeSmokeOutput', () => {
  it('counts an error that follows an EXPECT ERROR marker', () => {
    const r = analyzeSmokeOutput(
      [
        '--- 2 wallets',
        'EXPECT ERROR (bad evm)',
        'psql:x.sql:20: ERROR:  new row violates check constraint',
        'done',
      ].join('\n'),
    );
    expect(r).toMatchObject({
      expectedFailuresFired: 1,
      expectedFailuresDeclared: 1,
      problems: [],
    });
  });

  it('flags an error that no marker announced', () => {
    const r = analyzeSmokeOutput(
      ['--- 1 signup', 'psql:x.sql:5: ERROR:  relation "nope" does not exist'].join('\n'),
    );
    expect(r.problems.join('\n')).toMatch(/unexpected error/);
  });

  it('flags a marked statement that succeeded', () => {
    const r = analyzeSmokeOutput(
      ['EXPECT ERROR (should fail)', 'INSERT 0 1', '--- 3 next section'].join('\n'),
    );
    expect(r.expectedFailuresFired).toBe(0);
    expect(r.problems.join('\n')).toMatch(/expected failure did not happen/);
  });

  it('flags a marker still unanswered at the end of the output', () => {
    expect(analyzeSmokeOutput('EXPECT ERROR (last one)').problems).toHaveLength(1);
  });

  it('handles Windows line endings', () => {
    const r = analyzeSmokeOutput('EXPECT ERROR (a)\r\nERROR:  boom\r\n');
    expect(r.problems).toEqual([]);
    expect(r.expectedFailuresFired).toBe(1);
  });
});

describe('assertLocalDatabase', () => {
  it.each(['postgres://u:p@localhost/db', 'postgres://u:p@127.0.0.1:5432/db'])(
    'allows %s',
    (url) => {
      expect(() => assertLocalDatabase(url)).not.toThrow();
    },
  );

  it.each([
    'postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres',
    'postgres://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
  ])('refuses the hosted database %s', (url) => {
    expect(() => assertLocalDatabase(url)).toThrow(/non-local/);
  });
});
