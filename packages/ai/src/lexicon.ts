import { normalizeForScan } from './guard.js';

/**
 * Deterministic banned-language check for everything the model writes (A05 section 6.3). The product describes the
 * chart and its scenarios; it never tells a user what to do, never promises an outcome and never claims certainty.
 * A hit means one repair retry, then the template.
 */
const RULES: readonly (readonly [string, RegExp])[] = [
  [
    'IMPERATIVE_TRADE',
    /\b(?:you\s+(?:should|must|need\s+to|have\s+to|ought\s+to)\s+(?:buy|sell|long|short|enter|exit|close|take|open|add|go)|(?:buy|sell)\s+(?:now|here|immediately|this)|go\s+(?:long|short)\s+(?:now|here)|take\s+(?:this|the)\s+(?:trade|long|short)|enter\s+(?:a|the|your)\s+(?:long|short|trade|position)|(?:long|short)\s+it)\b/i,
  ],
  [
    'CERTAINTY',
    /\b(?:guarantee[ds]?|certainly|definitely|surely|for\s+sure|sure\s+thing|can['’]?t\s+lose|cannot\s+lose|risk[-\s]?free|no\s+risk|100\s*%\s*(?:win|safe|sure|certain)|cannot\s+fail|can['’]?t\s+fail|without\s+(?:any\s+)?risk)\b/i,
  ],
  [
    'PREDICTION',
    /\b(?:price|it|market|bitcoin|btc|eth|ethereum)\s+will\s+(?:go|rise|fall|drop|reach|hit|break|bounce|reverse|pump|dump|moon|crash|rally|test|sweep|continue)\b/i,
  ],
  [
    'PROFIT_PROMISE',
    /\b(?:easy\s+money|get\s+rich|make\s+(?:a\s+)?(?:money|profit|fortune)|will\s+profit|guaranteed\s+(?:profit|return)s?|free\s+money|printing\s+money)\b/i,
  ],
  [
    'PERSONAL_ADVICE',
    /\b(?:i\s+(?:recommend|advise|suggest\s+you)|my\s+advice|my\s+recommendation|financial\s+advice\s+is)\b/i,
  ],
  [
    'LEVERAGE_PUSH',
    /\b(?:use|try|go\s+with|increase|raise)\s+(?:\d+\s*x\s+)?(?:high\s+|more\s+|max(?:imum)?\s+)?(?:leverage|your\s+size|your\s+position)\b/i,
  ],
];

export interface LexiconHit {
  rule: string;
}

export function checkLexicon(raw: string): LexiconHit[] {
  const text = normalizeForScan(raw);
  const hits: LexiconHit[] = [];
  for (const [rule, re] of RULES) if (re.test(text)) hits.push({ rule });
  return hits;
}
