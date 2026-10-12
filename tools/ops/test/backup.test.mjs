import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { decryptStream, encryptStream, parseKey } from '../src/backup.mjs';

const collect = async (readable) => {
  const parts = [];
  for await (const c of readable) parts.push(c);
  return Buffer.concat(parts);
};
const encrypt = async (buf, key) => collect(Readable.from([buf]).pipe(encryptStream(key)));
const decrypt = async (buf, key) => {
  const out = [];
  await pipeline(Readable.from([buf]), decryptStream(key), async (src) => {
    for await (const c of src) out.push(c);
  });
  return Buffer.concat(out);
};

describe('backup encryption', () => {
  const key = randomBytes(32);

  it('round-trips data of any size, including more than one chunk', async () => {
    for (const n of [0, 1, 1000, 3 * 1024 * 1024 + 17]) {
      const data = randomBytes(n);
      // The stream encrypts per incoming piece; feed it in several.
      const pieces = [];
      for (let i = 0; i < data.length; i += 700_000) pieces.push(data.subarray(i, i + 700_000));
      const enc = await collect(Readable.from(pieces).pipe(encryptStream(key)));
      expect(enc.length).toBeGreaterThan(n);
      expect(await decrypt(enc, key)).toEqual(data);
    }
  });

  it('does not contain the plaintext', async () => {
    const data = Buffer.from(
      'a very recognisable string that must not appear in the file '.repeat(50),
    );
    const enc = await encrypt(data, key);
    expect(enc.includes(Buffer.from('recognisable'))).toBe(false);
  });

  it('a wrong key fails and yields nothing usable', async () => {
    const enc = await encrypt(randomBytes(5000), key);
    await expect(decrypt(enc, randomBytes(32))).rejects.toThrow(/wrong key or damaged/);
  });

  it('a flipped bit, a truncated file and a chopped-off end are all detected', async () => {
    const enc = await encrypt(randomBytes(5000), key);
    const flipped = Buffer.from(enc);
    flipped[40] = (flipped[40] ?? 0) ^ 1;
    await expect(decrypt(flipped, key)).rejects.toThrow();
    await expect(decrypt(enc.subarray(0, enc.length - 20), key)).rejects.toThrow();
    // Remove the end marker exactly (12 nonce + 4 len + 3 body + 16 tag): complete chunks, but no authenticated end.
    await expect(decrypt(enc.subarray(0, enc.length - 35), key)).rejects.toThrow(/incomplete/);
  });

  it('a file that is not a backup is refused', async () => {
    await expect(
      decrypt(Buffer.from('definitely not a backup file at all'), key),
    ).rejects.toThrow();
  });

  it('keys must be exactly 32 bytes', () => {
    expect(() => parseKey(undefined)).toThrow();
    expect(() => parseKey(Buffer.from('short').toString('base64'))).toThrow();
    expect(parseKey(randomBytes(32).toString('base64')).length).toBe(32);
  });
});
