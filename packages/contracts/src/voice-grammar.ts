import type { VoiceForbiddenAction } from './voice.js';

/**
 * The closed grammar of spoken (or typed) commands (A02 section 6.5). One definition shared by the browser and the
 * server, so what the device understands is exactly what the server accepts. It can only produce the commands in the
 * type: nothing that moves money, confirms a gate, logs a trade or deletes data is expressible here (invariant 1).
 */
export type VoiceCommand =
  | { command: 'EXPLAIN_CHART' }
  | { command: 'SWITCH_TF'; tf: string }
  | { command: 'SWITCH_INSTRUMENT'; text: string }
  | { command: 'SHOW_SETUP'; ordinal: number | 'NEXT' | 'PREVIOUS' }
  | { command: 'WATCH_SETUP'; watch: boolean }
  | { command: 'PAUSE_RESUME'; resume: boolean }
  | { command: 'MUTE'; muted: boolean }
  | { command: 'JOURNAL_NOTE'; note: string };

const TF_WORDS: Readonly<Record<string, string>> = {
  '1 minute': '1m',
  'one minute': '1m',
  '5 minute': '5m',
  'five minute': '5m',
  '15 minute': '15m',
  'fifteen minute': '15m',
  '30 minute': '30m',
  'thirty minute': '30m',
  '1 hour': '1h',
  'one hour': '1h',
  hourly: '1h',
  '4 hour': '4h',
  'four hour': '4h',
  daily: '1d',
  'one day': '1d',
  weekly: '1w',
  'one week': '1w',
};

const ORDINALS: Readonly<Record<string, number>> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
};

/** Lookalike letters from other alphabets that a person or a model could use to dodge a pattern. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0445': 'x',
  '\u0443': 'y',
  '\u0456': 'i',
  '\u0455': 's',
  '\u0501': 'd',
  '\u04BB': 'h',
  '\u0475': 'v',
};

/** Compatibility-normalise, drop invisible characters and map common lookalikes, before any rule is applied. */
export function normalizeSpoken(text: string): string {
  return text
    .normalize('NFKC')
    .replace(
      /[\u00AD\u061C\u115F\u1160\u17B4\u17B5\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF]/g,
      '',
    )
    .replace(/[\uFE00-\uFE0F]/g, '')
    .replace(
      /[\u0430\u0435\u043E\u0440\u0441\u0445\u0443\u0456\u0455\u0501\u04BB\u0475]/g,
      (c) => LOOKALIKES[c] ?? c,
    );
}

const norm = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, '')
    .replace(/\s+/g, ' ');

export function parseVoiceCommand(input: string): VoiceCommand | null {
  const raw = normalizeSpoken(input);
  const t = norm(raw);
  if (/^(?:please\s+)?explain\s+(?:this|the)\s+chart$/.test(t)) return { command: 'EXPLAIN_CHART' };
  if (/^(?:pause|stop\s+listening)$/.test(t)) return { command: 'PAUSE_RESUME', resume: false };
  if (/^(?:resume|continue)$/.test(t)) return { command: 'PAUSE_RESUME', resume: true };
  if (/^(?:mute|be\s+quiet|silence)$/.test(t)) return { command: 'MUTE', muted: true };
  if (/^(?:unmute|speak\s+again)$/.test(t)) return { command: 'MUTE', muted: false };
  if (/^(?:next\s+setup|show\s+(?:the\s+)?next\s+setup)$/.test(t))
    return { command: 'SHOW_SETUP', ordinal: 'NEXT' };
  if (/^(?:previous\s+setup|last\s+setup|show\s+(?:the\s+)?previous\s+setup)$/.test(t)) {
    return { command: 'SHOW_SETUP', ordinal: 'PREVIOUS' };
  }
  const show = /^show\s+setup\s+(\d{1,2}|one|two|three|four|five)$/.exec(t);
  if (show?.[1]) {
    const n = /^\d/.test(show[1]) ? Number(show[1]) : ORDINALS[show[1]];
    if (n && n >= 1) return { command: 'SHOW_SETUP', ordinal: n };
  }
  if (/^(?:watch|follow)\s+(?:this|the)\s+setup$/.test(t))
    return { command: 'WATCH_SETUP', watch: true };
  if (/^(?:stop\s+watching|unwatch)\s+(?:this|the)\s+setup$/.test(t))
    return { command: 'WATCH_SETUP', watch: false };

  const to =
    /^(?:switch\s+to|go\s+to|show|open)\s+(?:the\s+)?(.{1,40}?)(?:\s+(?:chart|timeframe))?$/.exec(
      t,
    );
  if (to?.[1] && !to[1].startsWith('setup') && !to[1].includes('setup')) {
    const v = to[1].trim();
    const short = /^(\d{1,3})\s?([mhdw])$/.exec(v);
    if (short) return { command: 'SWITCH_TF', tf: `${short[1]}${short[2]}` };
    const word = TF_WORDS[v];
    if (word) return { command: 'SWITCH_TF', tf: word };
    // Anything else that looks like a market name: the server resolves it and asks when it is ambiguous.
    // Only a name that was recognised as a market (the corrected text writes assets in capitals) counts; "show me the
    // risks" or "go to bed" are questions, not market switches.
    const original =
      /^(?:switch\s+to|go\s+to|show|open)\s+(?:the\s+)?(.{1,40}?)(?:\s+(?:chart|timeframe))?\s*[.!?]*$/i.exec(
        raw.trim(),
      );
    if (
      /\b[A-Z][A-Z0-9]{1,9}\b/.test(original?.[1] ?? '') &&
      /^[a-z0-9][a-z0-9 /:.-]{1,30}$/.test(v)
    ) {
      return { command: 'SWITCH_INSTRUMENT', text: v };
    }
  }
  const note = /^(?:note|journal)\s*[:,-]?\s+(.{3,280})$/.exec(raw.trim().toLowerCase());
  if (note?.[1]) return { command: 'JOURNAL_NOTE', note: note[1].slice(0, 280) };
  return null;
}

/** Requests for things voice may never do (invariant 1). Answered clearly, never acted on. */
const FORBIDDEN: readonly (readonly [VoiceForbiddenAction, RegExp])[] = [
  [
    'confirm_gate',
    /\b(?:confirm|approve|accept|authori[sz]e)\s+(?:the\s+|my\s+|this\s+)?(?:gate|plan)\b/i,
  ],
  [
    'confirm_trade',
    /\b(?:confirm|approve|accept|execute|place|submit)\s+(?:the\s+|my\s+|this\s+|an?\s+)?(?:trade|order)\b/i,
  ],
  ['log_trade', /\blog\s+(?:this\s+|my\s+|the\s+)?trade\b/i],
  [
    'change_risk',
    /\b(?:change|set|raise|lower|increase|reduce)\s+(?:my\s+|the\s+)?(?:risk|leverage)\b/i,
  ],
  ['delete_account', /\bdelete\s+(?:my\s+)?account\b/i],
  [
    'delete_data',
    /\b(?:delete|erase|wipe|remove)\s+(?:my\s+)?(?:data|journal|everything|history)\b/i,
  ],
  [
    'pay',
    /\b(?:pay\s+(?:the|my|for|now|invoice|bill|subscription)|purchase|buy\s+a\s+plan|subscribe|upgrade\s+(?:my|the|to|plan|account)|upgrade$)\b/i,
  ],
];

export function forbiddenByVoice(input: string): VoiceForbiddenAction | null {
  const text = normalizeSpoken(input).replace(/\s+/g, ' ');
  for (const [action, re] of FORBIDDEN) if (re.test(text)) return action;
  return null;
}

/** Kept for callers that only need a yes/no. */
export const FORBIDDEN_BY_VOICE = {
  test: (text: string): boolean => forbiddenByVoice(text) !== null,
};
