import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

export interface TestServer {
  /** Creates another empty database on the same server and returns its connection URL. */
  createDatabase(): Promise<string>;
  /** Stops the server (embedded) or drops every database created through it (existing server). */
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const dbName = () => `smc_test_${randomBytes(6).toString('hex')}`;

/**
 * A real Postgres for integration tests (never a mock: SQL behaviour is what we test).
 * - `TEST_DATABASE_URL` set (CI service container): databases are created on that server and dropped on stop.
 * - otherwise: boots an embedded Postgres in a temp directory (no installed server, no password to share).
 */
export async function startTestServer(): Promise<TestServer> {
  const server = process.env.TEST_DATABASE_URL;
  return server ? useExistingServer(server) : startEmbedded();
}

async function useExistingServer(serverUrl: string): Promise<TestServer> {
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  const created: string[] = [];
  return {
    async createDatabase() {
      const name = dbName();
      await admin.unsafe(`create database ${name}`);
      created.push(name);
      const url = new URL(serverUrl);
      url.pathname = `/${name}`;
      return url.toString();
    },
    async stop() {
      for (const name of created)
        await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function startEmbedded(): Promise<TestServer> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const databaseDir = mkdtempSync(join(tmpdir(), 'smc-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  // A failed spawn (for example a path over Windows' 260 character limit) never rejects inside the library,
  // so bound startup and say what to check instead of hanging until the test runner gives up.
  await withDeadline(
    (async () => {
      await pg.initialise();
      await pg.start();
    })(),
    90_000,
    'embedded Postgres did not start within 90 s; on Windows check that the repository path is short (under about 100 characters)',
  );
  return {
    async createDatabase() {
      const name = dbName();
      await pg.createDatabase(name);
      return `postgres://postgres:postgres@127.0.0.1:${port}/${name}`;
    },
    async stop() {
      await pg.stop();
      try {
        // Windows keeps the data files locked for a moment after the server exits.
        rmSync(databaseDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (error) {
        process.stderr.write(`could not remove ${databaseDir}: ${String(error)}\n`);
      }
    },
  };
}
