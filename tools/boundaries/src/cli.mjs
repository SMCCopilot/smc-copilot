#!/usr/bin/env node
// Runs both boundary layers: the manifest/purity checks and dependency-cruiser over whichever of
// apps/ and packages/ exist. Exit code is non-zero if either layer reports a violation.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBoundaries } from './check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, '../../..'));

const violations = checkBoundaries(root);
for (const v of violations) console.error(`boundary violation: ${v}`);

const targets = ['apps', 'packages'].filter((d) => existsSync(join(root, d)));
const depcruiseBin = join(here, '../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const cruise = spawnSync(
  process.execPath,
  [depcruiseBin, '--config', join(root, '.dependency-cruiser.cjs'), '--no-progress', ...targets],
  { cwd: root, stdio: 'inherit' },
);

if (violations.length > 0 || cruise.status !== 0) process.exit(1);
console.log('boundaries ok');
