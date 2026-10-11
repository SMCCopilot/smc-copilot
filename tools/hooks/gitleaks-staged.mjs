// Runs gitleaks on staged changes. Looks for the repo-local binary first (node tools/hooks/install-gitleaks.mjs),
// then PATH. If gitleaks is missing the hook warns and passes, unless SMC_REQUIRE_GITLEAKS=1, in which case it fails
// closed. CI runs gitleaks on the full history and is the enforcing gate either way.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const local = join(here, '../bin', process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
const candidates = existsSync(local) ? [local, 'gitleaks'] : ['gitleaks'];

// shell:true lets Windows resolve .cmd/.exe shims on PATH; arguments contain no user input.
const binary = candidates.find(
  (c) => spawnSync(`"${c}" version`, { shell: true, stdio: 'ignore' }).status === 0,
);
if (!binary) {
  const message =
    'gitleaks is not installed: run `node tools/hooks/install-gitleaks.mjs` (CI scans every push regardless).';
  if (process.env.SMC_REQUIRE_GITLEAKS === '1') {
    console.error(`${message} Blocking because SMC_REQUIRE_GITLEAKS=1.`);
    process.exit(1);
  }
  console.warn(`${message} Skipping the pre-commit secret scan.`);
  process.exit(0);
}

const scan = spawnSync(
  `"${binary}" git --staged --pre-commit --redact --no-banner --config .gitleaks.toml`,
  { shell: true, stdio: 'inherit' },
);
process.exit(scan.status ?? 1);
