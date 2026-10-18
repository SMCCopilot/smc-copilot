// Copies the on-device speech and OCR runtime files into public/vendor so the browser never loads code or models
// from a third-party CDN. Run before dev and build. The output is git-ignored.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = join(root, '..', '..', 'node_modules', '.pnpm');
const out = join(root, 'public', 'vendor');

function pkgDir(prefix, name) {
  const hit = readdirSync(store).find((d) => d.startsWith(`${prefix}@`));
  if (!hit) throw new Error(`${prefix} is not installed; run pnpm install`);
  return join(store, hit, 'node_modules', name);
}
function copy(from, to) {
  if (!existsSync(from)) throw new Error(`missing ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

const ort = join(pkgDir('onnxruntime-web', 'onnxruntime-web'), 'dist');
// Every runtime variant the library may pick (plain, jsep, asyncify, jspi): it chooses at run time by browser
// features, and a missing one made speech recognition fail to start on a live Chrome ("asyncify.mjs" not found).
for (const f of readdirSync(ort).filter((n) => /^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(n))) {
  copy(join(ort, f), join(out, 'ort', f));
}

const tess = pkgDir('tesseract.js', 'tesseract.js');
copy(join(tess, 'dist', 'worker.min.js'), join(out, 'tesseract', 'worker.min.js'));
const core = pkgDir('tesseract.js-core', 'tesseract.js-core');
for (const f of readdirSync(core).filter((n) => n.startsWith('tesseract-core'))) {
  copy(join(core, f), join(out, 'tesseract', 'core', f));
}
const lang = pkgDir(
  '@tesseract.js-data+eng'.replace('@tesseract.js-data+eng', '@tesseract.js-data+eng'),
  '@tesseract.js-data/eng',
);
copy(
  join(lang, '4.0.0_best_int', 'eng.traineddata.gz'),
  join(out, 'tesseract', 'lang', 'eng.traineddata.gz'),
);
process.stdout.write('vendor files copied to public/vendor');
