#!/usr/bin/env node
// pnpm voice:pin-models: pin the speech model files by revision and SHA-256 (A02 section 6.3).
//
//   pnpm voice:pin-models              fill in every missing revision, hash and size in the manifest
//   pnpm voice:pin-models --check      download nothing; fail if any entry is unpinned
//   pnpm voice:pin-models --verify     re-download and fail if any hash no longer matches
//
// It only downloads public model files (bandwidth, no cost). The result is committed, so the browser can refuse a file
// that has been swapped or corrupted.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST = join(here, '../../../apps/api/src/voice/model-manifest.json');
const HF = 'https://huggingface.co';

export async function latestRevision(repo, fetchImpl = fetch) {
  const r = await fetchImpl(`${HF}/api/models/${repo}`);
  if (!r.ok) throw new Error(`cannot read ${repo} (${r.status})`);
  const sha = (await r.json()).sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`no revision for ${repo}`);
  return sha;
}

export async function hashFile(url, fetchImpl = fetch) {
  const r = await fetchImpl(url);
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}) ${url}`);
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of r.body) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

export const urlOf = (repo, revision, path) => `${HF}/${repo}/resolve/${revision}/${path}`;

const groups = (m) => [...m.engines.map((e) => ({ name: e.tag, g: e })), { name: 'vad', g: m.vad }];

export function unpinned(m) {
  return groups(m).flatMap(({ name, g }) =>
    !g.revision || g.files.some((f) => !f.sha256 || !f.bytes) ? [name] : [],
  );
}

export async function pin(m, { verify = false, fetchImpl = fetch, log = console.log } = {}) {
  let changed = false;
  for (const { name, g } of groups(m)) {
    if (!g.revision) {
      g.revision = await latestRevision(g.repo, fetchImpl);
      changed = true;
    }
    for (const f of g.files) {
      if (f.sha256 && f.bytes && !verify) continue;
      log(`${verify ? 'verifying' : 'pinning'} ${name}/${f.id} ...`);
      const got = await hashFile(urlOf(g.repo, g.revision, f.path), fetchImpl);
      if (verify) {
        if (got.sha256 !== f.sha256 || got.bytes !== f.bytes)
          throw new Error(`${name}/${f.id} no longer matches its pinned hash`);
      } else {
        f.sha256 = got.sha256;
        f.bytes = got.bytes;
        changed = true;
      }
    }
  }
  return changed;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (args.has('--check')) {
    const u = unpinned(m);
    if (u.length > 0) {
      console.error(`unpinned: ${u.join(', ')}`);
      process.exitCode = 1;
    } else console.log('all speech models are pinned');
    return;
  }
  const changed = await pin(m, { verify: args.has('--verify') });
  if (changed) writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
  console.log(changed ? 'manifest updated' : 'nothing to do');
}

if (process.argv[1]?.endsWith('pin-models.mjs')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  });
}
