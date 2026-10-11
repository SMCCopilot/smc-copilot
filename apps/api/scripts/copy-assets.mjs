// Copies non-TypeScript files the compiled server reads at run time (the pinned speech-model manifest).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist/voice'), { recursive: true });
cpSync(join(root, 'src/voice/model-manifest.json'), join(root, 'dist/voice/model-manifest.json'));
