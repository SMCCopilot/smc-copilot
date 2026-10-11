import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBoundaries } from '../src/check.mjs';

const dirs = [];
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'smc-boundaries-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
const pkg = (name, deps = {}, devDeps = {}) =>
  JSON.stringify({ name: `@smc/${name}`, dependencies: deps, devDependencies: devDeps });
const engine = (src, extra = {}) =>
  fixture({
    'packages/contracts/package.json': pkg('contracts', { zod: '^4.0.0' }),
    'packages/smc-engine/package.json': pkg('smc-engine', { '@smc/contracts': 'workspace:*' }),
    'packages/smc-engine/src/x.ts': src,
    ...extra,
  });

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('package manifests', () => {
  it('accepts packages that depend on contracts only', () => {
    expect(checkBoundaries(engine('export const a = 1;'))).toEqual([]);
  });

  it('rejects a package that depends on an app (AC: importing apps/* from a package fails lint)', () => {
    const root = fixture({
      'apps/api/package.json': pkg('api'),
      'packages/ai/package.json': pkg('ai', { '@smc/api': 'workspace:*' }),
    });
    expect(checkBoundaries(root).join('\n')).toMatch(/depends on app @smc\/api/);
  });

  it.each(['smc-engine', 'market-data', 'ai', 'db', 'capture-kit'])(
    'rejects %s depending on a sibling package other than contracts',
    (name) => {
      const root = fixture({
        'packages/contracts/package.json': pkg('contracts', { zod: '^4' }),
        'packages/config/package.json': pkg('config'),
        [`packages/${name}/package.json`]: pkg(name, { '@smc/config': 'workspace:*' }),
      });
      expect(checkBoundaries(root).join('\n')).toMatch(/depends on @smc\/config/);
    },
  );

  it('sees through workspace aliases and unscoped workspace dependencies', () => {
    const root = fixture({
      'packages/ai/package.json': pkg('ai'),
      'packages/market-data/package.json': pkg('market-data', {
        alias: 'workspace:@smc/ai@*',
        'api-server': 'workspace:*',
      }),
    });
    const out = checkBoundaries(root).join('\n');
    expect(out).toMatch(/depends on @smc\/ai/);
    expect(out).toMatch(/outside the @smc scope/);
  });

  it('rejects an unknown package so new packages get a deliberate rule', () => {
    const root = fixture({ 'packages/mystery/package.json': pkg('mystery') });
    expect(checkBoundaries(root).join('\n')).toMatch(/not listed/);
  });

  it.each(['axios', 'nanoid', '@nestjs/common', 'pg'])(
    'rejects third-party dependency %s in the pure engine',
    (dep) => {
      const root = fixture({
        'packages/smc-engine/package.json': pkg('smc-engine', { [dep]: '^1.0.0' }),
      });
      expect(checkBoundaries(root).join('\n')).toMatch(/only @smc\/contracts is allowed/);
    },
  );
});

describe('pure package source (AST scan)', () => {
  it.each([
    ['Date.now()', 'export const t = Date.now();'],
    ['Date split over two lines', 'export const t = Date\n  .now();'],
    ['aliased Date.now', 'const now = Date.now;\nexport const t = now();'],
    ['computed Date access', "export const t = Date['now']();"],
    ['new Date without parens', 'export const t = new Date;'],
    ['Date() call', 'export const t = Date();'],
    ['local-time getter', 'export const h = new Date(5).getHours();'],
    ['Math.random()', 'export const r = Math.random();'],
    ['computed Math.random', "export const r = Math['random']();"],
    ['destructured Math', 'const { random } = Math;\nexport const r = random();'],
    ['Math.exp (arch-dependent)', 'export const r = Math.exp(1);'],
    ['Math.pow', 'export const r = Math.pow(2, 0.5);'],
    ['Intl formatting', 'export const s = new Intl.DateTimeFormat().format();'],
    ['string containing // before the call', "const s = '//'; export const t = Date.now();"],
    ['performance.now()', 'export const p = performance.now();'],
    ['process access', 'export const e = process.env.X;'],
    ['globalThis access', 'export const g = globalThis;'],
    ['setTimeout', 'setTimeout(() => {}, 1);'],
    ['fetch', 'await fetch("http://x");'],
    ['node builtin', "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;"],
    ['node timers', "import { setTimeout as s } from 'node:timers/promises';\nexport const f = s;"],
    ['nest import', "import { Injectable } from '@nestjs/common';\nexport const i = Injectable;"],
    ['third-party import', "import axios from 'axios';\nexport const a = axios;"],
    ['dynamic import', "export const m = await import('@nestjs/core');"],
    ['re-export from a bare module', "export { randomUUID } from 'node:crypto';"],
    ['import = require', "import fs = require('fs');\nexport const f = fs;"],
    ['require()', "export const f = require('fs');"],
  ])('rejects %s in the engine', (_label, code) => {
    expect(checkBoundaries(engine(code)).length).toBeGreaterThan(0);
  });

  it.each([
    ['.tsx', 'b.tsx'],
    ['.cts', 'c.cts'],
    ['.mjs', 'd.mjs'],
    ['a file named *.test.impl.ts that still ships in dist', 'x.test.impl.ts'],
  ])('scans %s files too', (_label, name) => {
    const root = engine('export const a = 1;', {
      [`packages/smc-engine/src/${name}`]: 'export const t = Date.now();',
    });
    expect(checkBoundaries(root).join('\n')).toMatch(new RegExp(name.replace('.', '\\.')));
  });

  it('allows the exact Math functions and relative imports the engine needs', () => {
    const root = engine(
      "import { y } from './y.js';\nimport type { Candle } from '@smc/contracts';\nexport const v = Math.max(Math.abs(y), Math.floor(1.5), Math.sqrt(4));\nexport type C = Candle;",
      { 'packages/smc-engine/src/y.ts': 'export const y = 1;' },
    );
    expect(checkBoundaries(root)).toEqual([]);
  });

  it('allows property names that merely spell a banned word', () => {
    const root = engine(
      'export const o = { Date: 1, process: 2 };\nexport const n = o.Date + o.process;',
    );
    expect(checkBoundaries(root)).toEqual([]);
  });

  it('ignores *.test.ts files (excluded from the build)', () => {
    const root = engine('export const a = 1;', {
      'packages/smc-engine/src/a.test.ts': 'export const t = Date.now();',
    });
    expect(checkBoundaries(root)).toEqual([]);
  });

  it('applies the same scan to contracts', () => {
    const root = fixture({
      'packages/contracts/package.json': pkg('contracts', { zod: '^4' }),
      'packages/contracts/src/x.ts': 'export const t = Date.now();',
    });
    expect(checkBoundaries(root).length).toBeGreaterThan(0);
  });
});
