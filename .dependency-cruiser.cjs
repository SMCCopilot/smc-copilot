// Import rules for A01 section 6, over the real import graph. Declared dependencies and the pure-package
// source scan live in tools/boundaries/src/check.mjs; this file checks what the source actually imports.
const PURE = '^packages/(smc-engine|capture-kit|contracts)/src';
const NO_IO =
  'node:|^(fs|fs/promises|net|http|https|http2|dgram|child_process|worker_threads|os|dns|tls|cluster|crypto|zlib|stream|readline|vm|perf_hooks|timers|timers/promises|sqlite|async_hooks|inspector|module|v8|tty|repl|process|test|diagnostics_channel)$';

const onlyContracts = (name) => ({
  name: `${name}-depends-on-contracts-only`,
  severity: 'error',
  from: { path: `^packages/${name}/src` },
  to: { path: '^packages/', pathNot: `^packages/(${name}|contracts)/` },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      comment: 'packages/* must never depend on apps/*',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-cross-package-relative-imports',
      severity: 'error',
      comment:
        'packages talk to each other through their published name, never through ../other-package',
      from: { path: '^packages/([^/]+)/src' },
      to: { path: '^packages/([^/]+)/', pathNot: '^packages/$1/' },
    },
    onlyContracts('smc-engine'),
    onlyContracts('analytics'),
    onlyContracts('market-data'),
    onlyContracts('ai'),
    onlyContracts('db'),
    onlyContracts('capture-kit'),
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'an import that cannot be resolved cannot be checked against the rules',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-nest-in-pure-packages',
      severity: 'error',
      comment: 'the engine, capture-kit and contracts know nothing about Nest',
      from: { path: PURE },
      to: { path: '@nestjs/' },
    },
    {
      name: 'no-node-core-in-pure-packages',
      severity: 'error',
      comment:
        'zero I/O in the engine and contracts; capture-kit runs in a browser. No Node core module at all',
      from: { path: PURE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-node-prefixed-imports-in-pure-packages',
      severity: 'error',
      comment: 'catches node: imports even where the core-module list would not know the name',
      from: { path: PURE },
      to: { path: NO_IO },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
