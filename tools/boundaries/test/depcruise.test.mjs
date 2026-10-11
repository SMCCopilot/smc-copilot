import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const config = resolve(here, '../../../.dependency-cruiser.cjs');
const depcruiseBin = resolve(here, '../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');

const dirs = [];
function cruise(files) {
  const root = mkdtempSync(join(tmpdir(), 'smc-depcruise-'));
  dirs.push(root);
  copyFileSync(resolve(here, '../../../tsconfig.base.json'), join(root, 'tsconfig.base.json'));
  mkdirSync(join(root, 'apps'), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const res = spawnSync(
    process.execPath,
    [depcruiseBin, '--config', config, '--no-progress', 'apps', 'packages'],
    { cwd: root, encoding: 'utf8' },
  );
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dependency-cruiser boundary rules (A01 section 6)', () => {
  it('passes a clean tree', () => {
    const r = cruise({
      'packages/smc-engine/src/a.ts': 'export const a = 1;',
      'packages/smc-engine/src/index.ts': "import { a } from './a.ts';\nexport const b = a;",
    });
    expect(r.out).toMatch(/no dependency violations/);
    expect(r.code).toBe(0);
  });

  it('fails when a package imports an app', () => {
    const r = cruise({
      'apps/api/src/x.ts': 'export const x = 1;',
      'packages/ai/src/index.ts':
        "import { x } from '../../../apps/api/src/x.ts';\nexport const y = x;",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/packages-never-import-apps/);
  });

  it('fails when the engine imports a node builtin', () => {
    const r = cruise({
      'packages/smc-engine/src/index.ts':
        "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(
      /no-node-core-in-pure-packages|no-node-prefixed-imports-in-pure-packages/,
    );
  });

  it('fails when capture-kit reaches into a sibling package', () => {
    const r = cruise({
      'packages/ai/src/index.ts': 'export const z = 1;',
      'packages/capture-kit/src/index.ts':
        "import { z } from '../../ai/src/index.ts';\nexport const w = z;",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(
      /capture-kit-depends-on-contracts-only|no-cross-package-relative-imports/,
    );
  });

  it.each([
    [
      'node:timers/promises',
      'packages/smc-engine/src/index.ts',
      "import { setTimeout as s } from 'node:timers/promises';\nexport const f = s;",
    ],
    [
      'node:sqlite',
      'packages/smc-engine/src/index.ts',
      "import { DatabaseSync } from 'node:sqlite';\nexport const d = DatabaseSync;",
    ],
    ['node:timers in contracts', 'packages/contracts/src/index.ts', "import 'node:timers';"],
    [
      'node:fs in capture-kit',
      'packages/capture-kit/src/index.ts',
      "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;",
    ],
  ])('fails on %s', (_label, path, code) => {
    const r = cruise({ [path]: code });
    expect(r.code).not.toBe(0);
  });

  it('fails on an import it cannot resolve (Nest in the engine, not installed in the fixture)', () => {
    const r = cruise({
      'packages/smc-engine/src/index.ts':
        "import { Injectable } from '@nestjs/common';\nexport const i = Injectable;",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not-to-unresolvable/);
  });
});
