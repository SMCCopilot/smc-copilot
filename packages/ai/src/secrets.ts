import { BIP39_WORDS } from './data/bip39.js';

/**
 * Detects a pasted seed phrase or private key (A05 section 12.2). Crypto users do paste these by mistake; a message
 * that matches is never sent to any model and is never stored. The result names the kind only, never the match.
 */
export type SecretKind =
  | 'SEED_PHRASE'
  | 'PRIVATE_KEY_HEX'
  | 'WIF_KEY'
  | 'EXTENDED_KEY'
  | 'SOLANA_KEY'
  | 'PEM_KEY'
  | 'API_KEY';

const WORDS = new Set(BIP39_WORDS);
const MIN_SEED_WORDS = 12;

const PATTERNS: readonly (readonly [SecretKind, RegExp])[] = [
  ['PRIVATE_KEY_HEX', /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/],
  ['WIF_KEY', /(?<![1-9A-HJ-NP-Za-km-z])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])/],
  ['EXTENDED_KEY', /\b[xyz]prv[1-9A-HJ-NP-Za-km-z]{100,}\b/],
  ['SOLANA_KEY', /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{86,88}(?![1-9A-HJ-NP-Za-km-z])/],
  ['SOLANA_KEY', /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ['PEM_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['API_KEY', /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{20,}\b/],
  ['API_KEY', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

/** True when 12 or more consecutive words are all BIP-39 words (a seed phrase is 12, 15, 18, 21 or 24 of them). */
function hasSeedRun(text: string): boolean {
  let run = 0;
  for (const m of text.toLowerCase().matchAll(/[a-z]+|[^a-z\s]+/g)) {
    const t = m[0];
    if (/^[a-z]+$/.test(t) && WORDS.has(t)) {
      run++;
      if (run >= MIN_SEED_WORDS) return true;
    } else {
      // Punctuation such as commas or numbering between words does not break a pasted list; other words do.
      if (/^[a-z]+$/.test(t)) run = 0;
    }
  }
  return false;
}

export function detectSecrets(text: string): SecretKind[] {
  const found = new Set<SecretKind>();
  if (hasSeedRun(text)) found.add('SEED_PHRASE');
  for (const [kind, re] of PATTERNS) if (re.test(text)) found.add(kind);
  return [...found];
}

export const containsSecret = (text: string): boolean => detectSecrets(text).length > 0;
