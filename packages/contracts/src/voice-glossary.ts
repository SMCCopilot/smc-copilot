import { z } from 'zod';
import { normalizeSpoken } from './voice-grammar.js';

/**
 * Spoken-form correction (A02 section 6.4). Speech engines hear "bee tee see perp" and "choke"; this turns what was
 * heard into the terms the product uses before the grammar or a model sees it. Shared by the browser (so the user sees
 * and can edit the corrected text) and the server (which re-applies it and is the authority). Pure and deterministic.
 */
export const GlossaryTermSchema = z.strictObject({
  canonical: z.string().min(1).max(40),
  spoken: z.array(z.string().min(1).max(40)).max(16),
});
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

export const GlossarySchema = z.strictObject({
  version: z.string().min(1).max(64),
  terms: z.array(GlossaryTermSchema).max(300),
  symbols: z.array(GlossaryTermSchema).max(500),
});
export type Glossary = z.infer<typeof GlossarySchema>;

/** Smart Money Concepts vocabulary with the ways speech engines tend to mishear it. */
export const SMC_TERMS: readonly GlossaryTerm[] = [
  {
    canonical: 'CHoCH',
    spoken: [
      'choke',
      'chalk',
      'choc',
      'chock',
      'cho ch',
      'c h o c h',
      'change of character',
      'chokes',
    ],
  },
  { canonical: 'BOS', spoken: ['boss', 'b o s', 'bee oh ess', 'break of structure'] },
  {
    canonical: 'FVG',
    spoken: ['f v g', 'eff vee gee', 'fair value gap', 'fair value gaps', 'fvgs'],
  },
  {
    canonical: 'order block',
    spoken: ['order blog', 'order bloc', 'ordered block', 'order blocks', 'order blocked'],
  },
  { canonical: 'OTE', spoken: ['o t e', 'oh tee ee', 'optimal trade entry'] },
  { canonical: 'EQH', spoken: ['e q h', 'equal highs'] },
  { canonical: 'EQL', spoken: ['e q l', 'equal lows'] },
  { canonical: 'ATR', spoken: ['a t r', 'average true range'] },
  { canonical: 'killzone', spoken: ['kill zone', 'kill zones', 'killzones'] },
  { canonical: 'liquidity', spoken: ['liquid ity', 'liquidy'] },
  { canonical: 'mitigation', spoken: ['mitigate ion', 'migration block'] },
  { canonical: 'displacement', spoken: ['displace meant', 'displacements'] },
  { canonical: 'inducement', spoken: ['in deuce meant', 'inducements'] },
  { canonical: 'premium', spoken: ['premier', 'premium zone'] },
  { canonical: 'perp', spoken: ['perk', 'purp', 'perps', 'perpetual', 'perpetuals'] },
  { canonical: 'journal', spoken: ['journal entry'] },
];

/** Well-known assets and how they are said. Others are added from the database, spelled letter by letter. */
export const SYMBOL_ALIASES: readonly GlossaryTerm[] = [
  { canonical: 'BTC', spoken: ['bee tee see', 'b t c', 'bitcoin', 'bit coin', 'btc'] },
  { canonical: 'ETH', spoken: ['e t h', 'ethereum', 'ether', 'eth', 'ee tee aitch'] },
  { canonical: 'SOL', spoken: ['s o l', 'solana', 'sol', 'ess oh el'] },
  { canonical: 'BNB', spoken: ['b n b', 'bee en bee', 'binance coin'] },
  { canonical: 'XRP', spoken: ['x r p', 'ex are pee', 'ripple'] },
  { canonical: 'DOGE', spoken: ['doge', 'doge coin', 'dogecoin'] },
  { canonical: 'ADA', spoken: ['a d a', 'cardano'] },
  { canonical: 'AVAX', spoken: ['a v a x', 'avalanche'] },
  { canonical: 'LINK', spoken: ['chainlink', 'chain link'] },
];

const LETTER_NAMES: Readonly<Record<string, string>> = {
  a: 'a',
  ay: 'a',
  bee: 'b',
  be: 'b',
  see: 'c',
  sea: 'c',
  cee: 'c',
  dee: 'd',
  ee: 'e',
  eff: 'f',
  gee: 'g',
  aitch: 'h',
  eye: 'i',
  jay: 'j',
  kay: 'k',
  el: 'l',
  ell: 'l',
  em: 'm',
  en: 'n',
  oh: 'o',
  pee: 'p',
  queue: 'q',
  are: 'r',
  ess: 's',
  tee: 't',
  tea: 't',
  you: 'u',
  vee: 'v',
  ex: 'x',
  why: 'y',
  zee: 'z',
  zed: 'z',
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  thirty: 30,
  sixty: 60,
  a: 1,
};

export interface Correction {
  from: string;
  to: string;
}
export interface CorrectionResult {
  text: string;
  changes: Correction[];
}

const lower = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/** Merges the static symbol aliases with assets known to the database (spoken by their letters). */
export function buildGlossary(bases: readonly string[], version = 'static'): Glossary {
  const known = new Set(SYMBOL_ALIASES.map((s) => s.canonical));
  const extra = [...new Set(bases.map((b) => b.toUpperCase()))]
    .filter((b) => /^[A-Z0-9]{2,10}$/.test(b) && !known.has(b))
    .sort()
    .map((b) => ({ canonical: b, spoken: [b.toLowerCase(), b.toLowerCase().split('').join(' ')] }));
  return { version, terms: [...SMC_TERMS], symbols: [...SYMBOL_ALIASES, ...extra] };
}

/** "fifteen minute" -> "15m", "four hour" -> "4h", "daily" stays for the grammar. */
function timeframes(text: string, changes: Correction[]): string {
  return text.replace(
    /\b(\d{1,3}|a|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty)[ -](minutes?|mins?|hours?|hrs?|days?|weeks?)\b/gi,
    (whole, n: string, unit: string) => {
      const v = /^\d/.test(n) ? Number(n) : NUMBER_WORDS[n.toLowerCase()];
      if (v === undefined) return whole;
      const u = unit.toLowerCase();
      const out = `${v}${u.startsWith('m') ? 'm' : u.startsWith('h') ? 'h' : u.startsWith('d') ? 'd' : 'w'}`;
      changes.push({ from: whole, to: out });
      return out;
    },
  );
}

/** Words that are also assets in the database but are ordinary speech first: never rewritten on their own. */
const COMMON_WORDS = new Set([
  'one',
  'link',
  'gas',
  'key',
  'time',
  'open',
  'sun',
  'the',
  'for',
  'you',
  'new',
  'top',
  'all',
  'now',
  'win',
  'fun',
  'run',
  'joy',
  'art',
  'ace',
  'bit',
  'got',
  'next',
  'cash',
  'trade',
  'move',
  'hold',
  'mask',
  'power',
  'rare',
  'real',
  'safe',
  'sand',
  'star',
  'swap',
  'true',
  'wave',
  'work',
  'world',
  'zero',
  'chain',
  'coin',
  'dog',
  'cat',
  'pepe_',
]);
const KNOWN_SHORT = new Set(['btc', 'eth', 'sol', 'bnb', 'xrp', 'ada', 'doge', 'avax']);
const saidAsSymbol = (w: string): boolean =>
  KNOWN_SHORT.has(w) || (w.length >= 4 && !COMMON_WORDS.has(w));

export function correctTranscript(input: string, g: Glossary): CorrectionResult {
  const changes: Correction[] = [];
  let text = ` ${lower(normalizeSpoken(input)).replace(/[.,!?]/g, ' ')} `.replace(/\s+/g, ' ');

  // 1. Multi-word and misheard phrases, longest first, whole-word matches only.
  const entries = [...g.terms, ...g.symbols]
    .flatMap((t) => t.spoken.map((s) => ({ spoken: lower(s), canonical: t.canonical })))
    .filter((e) => e.spoken !== lower(e.canonical))
    .sort((a, b) => b.spoken.length - a.spoken.length);
  for (const e of entries) {
    const needle = ` ${e.spoken} `;
    while (text.includes(needle)) {
      text = text.replace(needle, ` ${e.canonical} `);
      changes.push({ from: e.spoken, to: e.canonical });
    }
  }

  // 2. Spelled letters ("b t c", "bee tee see") that form a known symbol.
  const symbols = new Set(g.symbols.map((s) => s.canonical));
  const tokens = text.trim().split(' ');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let best: { len: number; sym: string } | null = null;
    let acc = '';
    for (let j = i; j < Math.min(tokens.length, i + 6); j++) {
      const tok = (tokens[j] ?? '').toLowerCase();
      const letter = tok.length === 1 && /[a-z]/.test(tok) ? tok : LETTER_NAMES[tok];
      if (!letter) break;
      acc += letter;
      if (j > i && symbols.has(acc.toUpperCase()))
        best = { len: j - i + 1, sym: acc.toUpperCase() };
    }
    if (best) {
      changes.push({ from: tokens.slice(i, i + best.len).join(' '), to: best.sym });
      out.push(best.sym);
      i += best.len;
    } else {
      out.push(tokens[i] ?? '');
      i++;
    }
  }
  // A symbol said as a word ("pepe", "sol") is written the way the product writes it.
  text = out
    .map((w) =>
      w === w.toLowerCase() && symbols.has(w.toUpperCase()) && saidAsSymbol(w)
        ? w.toUpperCase()
        : w,
    )
    .join(' ');

  // 3. Timeframe phrases, and the number after "setup" ("show setup too" is "show setup 2").
  text = timeframes(text, changes);
  text = text.replace(/\bset up\b/g, (m) => {
    changes.push({ from: m, to: 'setup' });
    return 'setup';
  });
  text = text.replace(
    /\bsetup (won|one|too|to|two|tree|three|for|four|five)\b/g,
    (whole, w: string) => {
      const n = {
        won: 1,
        one: 1,
        too: 2,
        to: 2,
        two: 2,
        tree: 3,
        three: 3,
        for: 4,
        four: 4,
        five: 5,
      }[w];
      if (n === undefined) return whole;
      changes.push({ from: whole, to: `setup ${n}` });
      return `setup ${n}`;
    },
  );

  // 4. One-edit slips on longer single-word terms ("liquidty").
  const singles = g.terms.map((t) => t.canonical).filter((c) => /^[a-z]{6,}$/.test(c));
  text = text
    .split(' ')
    .map((w) => {
      if (w.length < 6 || singles.includes(w)) return w;
      const hit = singles.find(
        (c) => Math.abs(c.length - w.length) <= 1 && levenshtein(c, w) === 1,
      );
      if (hit) {
        changes.push({ from: w, to: hit });
        return hit;
      }
      return w;
    })
    .join(' ');

  return { text: text.replace(/\s+/g, ' ').trim(), changes };
}
