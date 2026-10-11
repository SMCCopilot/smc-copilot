import { describe, expect, it } from 'vitest';
import { BIP39_WORDS } from '../src/data/bip39.js';
import { containsSecret, detectSecrets } from '../src/secrets.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => B58[(i * 7 + seed * 13 + (i % 5)) % B58.length]).join('');
const phrase = (start: number, n: number) =>
  Array.from({ length: n }, (_, i) => BIP39_WORDS[start + i * 37]).join(' ');

describe('secret detector: things that must be caught (20 patterns)', () => {
  const secrets: [string, string][] = [
    ['12-word seed', phrase(10, 12)],
    ['15-word seed', phrase(200, 15)],
    ['18-word seed', phrase(333, 18)],
    ['24-word seed', phrase(500, 24)],
    ['seed with commas', phrase(900, 12).split(' ').join(', ')],
    ['seed with newlines', phrase(1200, 12).split(' ').join('\n')],
    ['seed in a sentence', `my wallet words are ${phrase(70, 12)} please help`],
    ['uppercase seed', phrase(1500, 12).toUpperCase()],
    [
      'famous test vector',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ],
    [
      'numbered seed',
      phrase(40, 12)
        .split(' ')
        .map((w, i) => `${i + 1}. ${w}`)
        .join(' '),
    ],
    ['64 hex key', `${'a'.repeat(32)}0123456789abcdef0123456789abcdef`],
    ['0x 64 hex key', `0x${'1f'.repeat(32)}`],
    ['WIF', '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ'],
    ['xprv', `xprv${b58(107, 1)}`],
    ['solana secret (base58)', b58(88, 2)],
    ['solana keypair array', `[${Array.from({ length: 64 }, (_, i) => (i * 3) % 256).join(',')}]`],
    ['PEM', '-----BEGIN PRIVATE KEY-----\nMIIE'],
    ['EC PEM', '-----BEGIN EC PRIVATE KEY-----'],
    ['anthropic key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['gemini key', `AIza${'a1B2c3D4e5'.repeat(3)}xyz12`],
  ];
  it.each(secrets)('%s', (_n, text) => {
    expect(containsSecret(text)).toBe(true);
  });
  it('names the kind but never echoes the match', () => {
    const kinds = detectSecrets(phrase(10, 12));
    expect(kinds).toEqual(['SEED_PHRASE']);
  });
});

describe('secret detector: ordinary text must pass (20 sentences)', () => {
  const ordinary = [
    'I want to learn how to read the market with patience and discipline.',
    'Why did price sweep the Asian low and then reverse before the London open?',
    'Explain the order block at the base of the move and what makes it fresh.',
    'Can you explain the difference between a break of structure and a change of character?',
    'What does it mean when liquidity above equal highs gets taken?',
    'The trend looks strong, but the volume is weak, so I am cautious about the next move.',
    'Show me the setup again; the entry zone and the invalidation were unclear to me.',
    'Please summarize my last five trades and what I did wrong with my risk.',
    'Is the current structure bullish on the four hour, and is the pullback deep enough?',
    'Who sets the bias when the daily and the four hour disagree about direction?',
    'When the market is quiet, avoid chasing; wait for the sweep, the reaction, and the retest.',
    'Add a note: I should wait for confirmation before I think about entry next time.',
    'What is a fair value gap and why does price often return to fill it?',
    'My plan is simple: follow the bias, respect the stop, and accept the result.',
    'Tell me about the killzone and the best session to watch for a reaction.',
    'above all, avoid overtrading; ability matters less than patience and a clear process',
    'Money management first: limit the risk on every trade and keep a journal of each result.',
    'Is this chart showing a trap, a sweep, or a real break? Explain it like I am new.',
    'The ocean of liquidity sits behind the swing; the market will often seek it before it turns.',
    'I tried to be careful: wait, check the bias, mark the zone, then decide calmly.',
  ];
  it.each(ordinary.map((t) => [t.slice(0, 50), t] as const))('%s', (_n, text) => {
    expect(containsSecret(text)).toBe(false);
  });
  it('a long list of unrelated numbers is not a keypair', () => {
    expect(containsSecret('1, 2, 3, 4, 5, 6, 7, 8, 9, 10')).toBe(false);
  });
});
