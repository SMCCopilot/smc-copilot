#!/usr/bin/env node
import { spawn } from 'node:child_process';
// Encrypted logical backup and restore of the database (B05 week 16, day 3; runbook docs/runbooks/backup-restore.md).
//
//   BACKUP_KEY=<base64 of 32 random bytes> node tools/ops/src/backup.mjs backup  --out smc-2026-10-12.dump.enc
//   BACKUP_KEY=...                           node tools/ops/src/backup.mjs restore --in  smc-2026-10-12.dump.enc --to <scratch database url>
//   node tools/ops/src/backup.mjs key                       prints a fresh key (store it in your password manager, not in the repo)
//
// Needs pg_dump / pg_restore on the PATH (PostgreSQL client tools). Reads DATABASE_URL_SESSION (or DATABASE_URL) for backup.
// The file is AES-256-GCM encrypted in chunks, so a wrong key or a damaged file fails loudly and nothing is restored.
// Restore refuses a target that looks like the production database unless --i-know-this-is-not-production is given.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('SMCBK1\n');
const CHUNK = 1024 * 1024;

export function parseKey(b64) {
  const key = Buffer.from(b64 ?? '', 'base64');
  if (key.length !== 32)
    throw new Error(
      'BACKUP_KEY must be 32 random bytes, base64 encoded (node tools/ops/src/backup.mjs key)',
    );
  return key;
}

/** Splits a byte stream into fixed-size chunks. */
function chunker(size) {
  let buf = Buffer.alloc(0);
  return new Transform({
    transform(data, _e, cb) {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= size) {
        this.push(buf.subarray(0, size));
        buf = buf.subarray(size);
      }
      cb();
    },
    flush(cb) {
      if (buf.length > 0) this.push(buf);
      cb();
    },
  });
}

/** Each chunk: 12-byte nonce, 4-byte ciphertext length, ciphertext, 16-byte tag. The chunk index is authenticated. */
export function encryptStream(key) {
  let index = 0;
  let wroteMagic = false;
  return new Transform({
    transform(chunk, _e, cb) {
      if (!wroteMagic) {
        this.push(MAGIC);
        wroteMagic = true;
      }
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, nonce);
      const aad = Buffer.alloc(8);
      aad.writeBigUInt64BE(BigInt(index++));
      c.setAAD(aad);
      const body = Buffer.concat([c.update(chunk), c.final()]);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      this.push(Buffer.concat([nonce, len, body, c.getAuthTag()]));
      cb();
    },
    flush(cb) {
      if (!wroteMagic) this.push(MAGIC);
      // An authenticated end marker, so a file cut short at a chunk boundary is detected.
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, nonce);
      const aad = Buffer.alloc(8);
      aad.writeBigUInt64BE(BigInt(index));
      c.setAAD(aad);
      const body = Buffer.concat([c.update(Buffer.from('END')), c.final()]);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(0xffffffff);
      this.push(Buffer.concat([nonce, len, body, c.getAuthTag()]));
      cb();
    },
  });
}

export function decryptStream(key) {
  let buf = Buffer.alloc(0);
  let index = 0;
  let started = false;
  let ended = false;
  return new Transform({
    transform(data, _e, cb) {
      try {
        buf = Buffer.concat([buf, data]);
        if (!started) {
          if (buf.length < MAGIC.length) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a backup file');
          buf = buf.subarray(MAGIC.length);
          started = true;
        }
        for (;;) {
          if (buf.length < 16) break;
          const len = buf.readUInt32BE(12);
          const isEnd = len === 0xffffffff;
          const bodyLen = isEnd ? 3 : len;
          const total = 16 + bodyLen + 16;
          if (buf.length < total) break;
          const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
          const aad = Buffer.alloc(8);
          aad.writeBigUInt64BE(BigInt(index));
          d.setAAD(aad);
          d.setAuthTag(buf.subarray(16 + bodyLen, total));
          const plain = Buffer.concat([d.update(buf.subarray(16, 16 + bodyLen)), d.final()]);
          buf = buf.subarray(total);
          if (isEnd) {
            ended = true;
            if (buf.length > 0) throw new Error('data after the end of the backup');
            break;
          }
          index++;
          this.push(plain);
        }
        cb();
      } catch {
        cb(new Error('the backup cannot be decrypted: wrong key or damaged file'));
      }
    },
    flush(cb) {
      cb(ended ? null : new Error('the backup is incomplete'));
    },
  });
}

function run(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], ...opts });
  child.on('error', (e) => {
    console.error(
      `could not run ${cmd}: ${e.code === 'ENOENT' ? 'install the PostgreSQL client tools and put them on the PATH' : e.message}`,
    );
    process.exitCode = 2;
  });
  return child;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (n) => rest[rest.indexOf(n) + 1];
  if (cmd === 'key') {
    console.log(randomBytes(32).toString('base64'));
    return;
  }
  const key = parseKey(process.env.BACKUP_KEY);
  if (cmd === 'backup') {
    const url = process.env.DATABASE_URL_SESSION || process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL_SESSION or DATABASE_URL must be set');
    const out = arg('--out');
    if (!out) throw new Error('--out <file> is required');
    // Plain schema "public" only: Supabase manages the other schemas. -Fc is the compressed custom format.
    const dump = run('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--schema=public',
      '--dbname',
      url,
    ]);
    await pipeline(dump.stdout, chunker(CHUNK), encryptStream(key), createWriteStream(out));
    console.log(`backup written to ${out}`);
  } else if (cmd === 'restore') {
    const inp = arg('--in');
    const to = arg('--to');
    if (!inp || !to) throw new Error('--in <file> and --to <database url> are required');
    if (
      !rest.includes('--i-know-this-is-not-production') &&
      process.env.DATABASE_URL &&
      to === process.env.DATABASE_URL
    ) {
      throw new Error('refusing to restore over DATABASE_URL; restore into a scratch database');
    }
    const restore = run('pg_restore', [
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      '--exit-on-error',
      '--dbname',
      to,
    ]);
    await pipeline(createReadStream(inp), decryptStream(key), restore.stdin);
    console.log('restore finished');
  } else {
    console.log(
      'usage: backup.mjs key | backup --out <file> | restore --in <file> --to <database url>',
    );
    process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith('backup.mjs')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  });
}
