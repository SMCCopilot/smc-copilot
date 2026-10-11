// Downloads a pinned gitleaks release into tools/bin (git-ignored), verifying its published SHA-256.
// No system install and no admin rights. Usage: node tools/hooks/install-gitleaks.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '8.30.1';
const here = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(here, '../bin');

const platform = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
if (!platform || !arch) {
  console.error(`unsupported platform ${process.platform}/${process.arch}`);
  process.exit(2);
}
const ext = platform === 'windows' ? 'zip' : 'tar.gz';
const asset = `gitleaks_${VERSION}_${platform}_${arch}.${ext}`;
const base = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}`;
const exe = join(binDir, platform === 'windows' ? 'gitleaks.exe' : 'gitleaks');

if (existsSync(exe)) {
  console.log(`gitleaks already installed at ${exe}`);
  process.exit(0);
}

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

const [archive, checksums] = await Promise.all([
  get(`${base}/${asset}`),
  get(`${base}/gitleaks_${VERSION}_checksums.txt`),
]);
const expected = checksums
  .toString('utf8')
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .find(([, name]) => name === asset)?.[0];
const actual = createHash('sha256').update(archive).digest('hex');
if (!expected || expected !== actual) {
  console.error(`checksum mismatch for ${asset}; refusing to install`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'gitleaks-'));
try {
  const file = join(work, asset);
  writeFileSync(file, archive);
  mkdirSync(binDir, { recursive: true });
  // Extract inside the temp dir with relative paths: GNU tar (Git Bash) reads "C:" as a host name, and only
  // bsdtar (Windows System32) can unpack a zip.
  const tar =
    platform === 'windows'
      ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
      : 'tar';
  const untar = spawnSync(tar, ['-xf', asset], { cwd: work, stdio: 'inherit' });
  if (untar.status !== 0) throw new Error('could not extract the gitleaks archive');
  copyFileSync(join(work, platform === 'windows' ? 'gitleaks.exe' : 'gitleaks'), exe);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`installed gitleaks ${VERSION} (checksum verified) at ${exe}`);
