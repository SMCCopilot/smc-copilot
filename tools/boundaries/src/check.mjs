// Package boundary rules from A01 section 6.
//   1. package.json: which workspace and third-party packages each package may declare.
//   2. source: for the pure packages (engine, contracts) an AST scan for clocks, randomness, I/O, global access
//      and imports outside an allow-list. The scan is syntactic on purpose: it cannot be dodged by splitting a
//      call over lines, aliasing, destructuring or computed property access, which a line regex can.
// dependency-cruiser (see .dependency-cruiser.cjs) separately checks the real import graph.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** @type {Record<string, string[]>} workspace packages each package may depend on (besides itself). */
export const ALLOWED_INTERNAL = {
  contracts: [],
  'smc-engine': ['contracts'],
  // statistics, risk arithmetic, calibration and backtest maths (no I/O; may use logarithms, unlike the engine)
  analytics: ['contracts'],
  'market-data': ['contracts'],
  ai: ['contracts'],
  db: ['contracts'],
  'capture-kit': ['contracts'],
  config: [],
  // test harness: golden datasets and replay need the pure packages
  testing: ['contracts', 'smc-engine', 'market-data', 'config'],
};

/**
 * Pure packages (invariant 3 and A02 section 9): no I/O, no clock, no randomness, no framework.
 * `modules` is the complete list of non-relative import specifiers the source may use.
 * `runtimeDeps` / `devDeps` are the complete lists of third-party packages package.json may declare.
 */
export const PURE_PACKAGES = {
  'smc-engine': {
    modules: ['@smc/contracts'],
    runtimeDeps: ['@smc/contracts'],
    devDeps: ['vitest', 'fast-check', 'typescript'],
  },
  contracts: {
    modules: ['zod'],
    runtimeDeps: ['zod'],
    devDeps: ['vitest', 'fast-check', 'typescript'],
  },
};

const BANNED_GLOBALS = new Set([
  'Date', // wall clock and local-time getters
  'Intl', // locale and time-zone dependent output
  'process',
  'globalThis',
  'window',
  'self',
  'document',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'queueMicrotask',
  'fetch',
  'performance',
  'require',
  'eval',
  'Function',
  'crypto',
  'WebAssembly',
  'XMLHttpRequest',
  'WebSocket',
  'Atomics',
  'SharedArrayBuffer',
  'Buffer',
]);

/**
 * Math members that are exactly specified by IEEE-754 / ECMAScript. The transcendental functions
 * (exp, log, pow, sin, ...) are implementation-approximated and can differ between CPU architectures,
 * which would break byte-identical output between the arm64 VM and an x64 CI runner.
 */
const ALLOWED_MATH = new Set([
  'abs',
  'min',
  'max',
  'floor',
  'ceil',
  'round',
  'trunc',
  'sign',
  'sqrt',
  'fround',
  'clz32',
  'imul',
  'PI',
  'E',
  'LN2',
  'LN10',
  'SQRT2',
  'EPSILON',
]);

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.ts$/; // exactly what tsconfig.build.json excludes
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (n) => statSync(join(dir, n)).isDirectory() && n !== 'node_modules',
  );
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** The package a dependency really resolves to, following `workspace:@scope/name@*` aliases. */
function resolvedName(name, spec) {
  const alias = /^workspace:(@?[^@]+(?:\/[^@]+)?)@/.exec(String(spec));
  return alias ? alias[1] : name;
}

function checkManifest(root, pkg, manifest, violations) {
  const pure = PURE_PACKAGES[pkg];
  const allowedInternal = ALLOWED_INTERNAL[pkg];
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const real = resolvedName(name, spec);
      const isWorkspace = String(spec).startsWith('workspace:');
      if (real.startsWith('@smc/')) {
        const target = real.slice('@smc/'.length);
        if (existsSync(join(root, 'apps', target))) {
          violations.push(
            `packages/${pkg}: depends on app ${real}; packages must never depend on apps`,
          );
        } else if (target !== pkg && !allowedInternal.includes(target)) {
          violations.push(
            `packages/${pkg}: depends on ${real}; allowed: ${allowedInternal.join(', ') || 'none'}`,
          );
        }
      } else if (isWorkspace) {
        violations.push(
          `packages/${pkg}: workspace dependency ${name} (${spec}) is outside the @smc scope`,
        );
      }
      if (pure && !real.startsWith('@smc/')) {
        const allowed = field === 'devDependencies' ? pure.devDeps : pure.runtimeDeps;
        if (!allowed.includes(real)) {
          violations.push(
            `packages/${pkg}: ${field} declares ${real}; only ${allowed.join(', ') || 'nothing'} is allowed in a pure package`,
          );
        }
      } else if (pure && real.startsWith('@smc/') && field !== 'devDependencies') {
        if (!pure.runtimeDeps.includes(real) && real !== `@smc/${pkg}`) {
          violations.push(
            `packages/${pkg}: ${field} declares ${real}, not allowed in a pure package`,
          );
        }
      }
    }
  }
}

function scanSource(file, root, pkg, rule, violations) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const where = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${relative(root, file).replaceAll('\\', '/')}:${line + 1}`;
  };
  const bad = (node, why) => violations.push(`${where(node)}: ${why} (pure package ${pkg})`);

  const checkSpecifier = (node, spec) => {
    const relativeSpec = spec.startsWith('./') || spec.startsWith('../');
    if (relativeSpec) return;
    if (!rule.modules.includes(spec) && !rule.modules.some((m) => spec.startsWith(`${m}/`))) {
      bad(node, `import of "${spec}" is not on the allow-list [${rule.modules.join(', ')}]`);
    }
  };

  const isNameOf = (node) => {
    const p = node.parent;
    if (!p) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
    if (
      (ts.isPropertyAssignment(p) ||
        ts.isPropertySignature(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isMethodSignature(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isEnumMember(p)) &&
      p.name === node
    ) {
      return true;
    }
    if (ts.isBindingElement(p) && p.propertyName === node) return true;
    return false;
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node, node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(node, node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      bad(node, '`import = require()` is not allowed');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      bad(node, 'dynamic import() is not allowed');
    } else if (ts.isIdentifier(node) && !isNameOf(node)) {
      if (BANNED_GLOBALS.has(node.text)) {
        bad(
          node,
          `use of \`${node.text}\` is not allowed (clock, randomness, I/O or global access)`,
        );
      } else if (node.text === 'Math') {
        const p = node.parent;
        const member =
          p && ts.isPropertyAccessExpression(p) && p.expression === node ? p.name.text : null;
        if (member === null || !ALLOWED_MATH.has(member)) {
          bad(node, `Math${member ? `.${member}` : ''} is not on the deterministic allow-list`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * @param {string} root repository root
 * @returns {string[]} human-readable violations (empty means clean)
 */
export function checkBoundaries(root) {
  const violations = [];

  for (const pkg of listDirs(join(root, 'packages'))) {
    const manifestPath = join(root, 'packages', pkg, 'package.json');
    if (!existsSync(manifestPath)) continue;
    if (!ALLOWED_INTERNAL[pkg]) {
      violations.push(`packages/${pkg}: not listed in ALLOWED_INTERNAL; add its rule deliberately`);
      continue;
    }
    checkManifest(root, pkg, readJson(manifestPath), violations);

    const rule = PURE_PACKAGES[pkg];
    const src = join(root, 'packages', pkg, 'src');
    if (rule && existsSync(src)) {
      for (const file of walk(src)) {
        if (SOURCE_EXT.test(file) && !TEST_FILE.test(file)) {
          scanSource(file, root, pkg, rule, violations);
        }
      }
    }
  }
  return violations;
}
