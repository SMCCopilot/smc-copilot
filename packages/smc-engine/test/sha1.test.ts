import { describe, expect, it } from 'vitest';
import { sha1 } from '../src/sha1.js';

describe('sha1 (FIPS 180-4 vectors)', () => {
  it.each([
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    ],
    ['a'.repeat(1_000_000), '34aa973cd4c4daa4f61eeb2bdbad27316534016f'],
    ['The quick brown fox jumps over the lazy dog', '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'],
  ])('hashes %#', (input, expected) => {
    expect(sha1(input)).toBe(expected);
  });

  it.each([
    ['é', 'bf15be717ac1b080b4f1c456692825891ff5073d'],
    ['😀', '9c533688a979a858cbd6a43c9f91aba624651f18'],
    ['日本語 BINANCE|15m', '91ae93f0631b9370dd7c521e7a7cff1a52a91f58'],
  ])('hashes multi-byte text as UTF-8 (%#, reference from node:crypto)', (input, expected) => {
    expect(sha1(input)).toBe(expected);
  });
});
