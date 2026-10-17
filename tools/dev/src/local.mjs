#!/usr/bin/env node
// One tool for running SMC Copilot on this PC against your own Supabase project (docs/RUN-LOCALLY.md).
//
//   pnpm local check              what is set and what is missing in .env.local (names only, never values)
//   pnpm local migrate            create/upgrade the tables in your database (safe to repeat)
//   pnpm local invite [--uses N]  make a real invite code in your database and print it
//   pnpm local admin [user-id]    give a signed-in user the admin role (no id: lists users, newest first)
//   pnpm local start [--no-ingest] [--no-build]
//                                 build if needed, then start the API and the web app (http://localhost:3000)
//
// Nothing here writes test data. `invite` and `admin` only change what you ask for.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(root, '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const set = (name) => Boolean(process.env[name] && process.env[name].trim() !== '');
const dbUrl = () => process.env.DATABASE_URL_SESSION || process.env.DATABASE_URL;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, extraEnv = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  return r.status === 0;
}

function check() {
  const need = [
    ['DATABASE_URL', 'the database (Supabase connection string, transaction pooler)'],
    ['DATABASE_URL_SESSION', 'the database for creating tables (session pooler or direct)'],
    ['SUPABASE_URL', 'your Supabase project URL'],
    ['SUPABASE_JWKS_URL', 'where sign-in tokens are checked'],
    [
      'SUPABASE_ANON_KEY',
      'the PUBLIC anon key (Project settings > API), needed by the browser page',
    ],
    ['WS_TOKEN_SECRET', 'a long random text (32+ characters) for live-connection tokens'],
  ];
  let ok = true;
  console.log('Required in .env.local:');
  for (const [name, why] of need) {
    const here = set(name);
    if (!here) ok = false;
    console.log(`  ${here ? 'ok     ' : 'MISSING'}  ${name}  - ${why}`);
  }
  console.log('Optional:');
  for (const [name, why] of [
    ['ANTHROPIC_API_KEY', 'AI explanations from Anthropic (template text is used without any key)'],
    ['OPENAI_API_KEY', 'AI explanations from OpenAI'],
    ['GEMINI_API_KEY', 'AI explanations from Gemini'],
    ['ADMIN_IP_ALLOWLIST', 'admin screens; use 127.0.0.1,::1 on this PC'],
    ['DNS_SERVERS', 'set to 1.1.1.1 if your network cannot reach Binance/Bybit'],
  ])
    console.log(`  ${set(name) ? 'set    ' : 'not set'}  ${name}  - ${why}`);
  if (!existsSync(envFile)) console.log('\nThere is no .env.local file in the project folder.');
  if (!ok)
    console.log(
      '\nAdd the missing names to .env.local (never paste them into chat), then run this again.',
    );
  return ok;
}

async function withDb(fn) {
  const url = dbUrl();
  if (!url) throw new Error('DATABASE_URL_SESSION or DATABASE_URL is not set in .env.local');
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function build() {
  console.log('Building (a few minutes the first time)...');
  if (!run(pnpm, ['build'])) throw new Error('the build failed; the messages above say where');
}

async function main() {
  if (cmd === 'check') {
    process.exitCode = check() ? 0 : 1;
  } else if (cmd === 'migrate') {
    if (!existsSync(resolve(root, 'packages/db/dist/cli/migrate.js'))) build();
    if (!run('node', ['packages/db/dist/cli/migrate.js'])) process.exitCode = 1;
  } else if (cmd === 'invite') {
    const uses = Number(option('--uses') ?? 1);
    if (!Number.isInteger(uses) || uses < 1)
      throw new Error('--uses must be a whole number, 1 or more');
    const code = `SMC-${randomBytes(5).toString('hex').toUpperCase()}`;
    await withDb(
      (sql) =>
        sql`insert into invite_codes (code, note, max_uses) values (${code}, 'created by pnpm local invite', ${uses})`,
    );
    console.log(`Invite code: ${code}   (can be used ${uses} time${uses === 1 ? '' : 's'})`);
  } else if (cmd === 'admin') {
    const id = rest.find((a) => !a.startsWith('--'));
    await withDb(async (sql) => {
      if (!id) {
        const users = await sql`
          select u.id, u.created_at, coalesce(u.raw_app_meta_data->>'role', '') as role,
                 (select count(*) from wallet_identities w where w.user_id = u.id)::int as wallets
            from auth.users u order by u.created_at desc limit 10`;
        if (users.length === 0)
          console.log('No users yet. Sign in once on the browser page, then run this again.');
        for (const u of users)
          console.log(
            `${u.id}  created ${u.created_at.toISOString()}  wallets ${u.wallets}  role ${u.role || 'user'}`,
          );
        console.log(
          '\nTo make one an admin:  pnpm local admin <id>   (then sign out and in again)',
        );
        return;
      }
      const r = await sql`
        update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
         where id = ${id} returning id`;
      console.log(
        r.length
          ? 'Done. Sign out and sign in again on the page to get the admin role.'
          : 'No user with that id.',
      );
    });
  } else if (cmd === 'start') {
    if (!check()) {
      process.exitCode = 1;
      return;
    }
    if (!flag('--no-build') && !existsSync(resolve(root, 'apps/api/dist/main.js'))) build();
    const port = process.env.PORT || '3002';
    console.log(
      `\nStarting the server on port ${port} and the web app. Open  http://localhost:3000  in your browser. Stop with Ctrl+C.\n`,
    );
    const child = spawn('node', ['apps/api/dist/main.js'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        TURNSTILE_DISABLED: 'true',
        ENGINE_ENABLED: 'true',
        INGEST_ENABLED: flag('--no-ingest') ? 'false' : 'true',
      },
    });
    const web = spawn('pnpm', ['--filter', '@smc/web', 'dev'], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', () => web.kill());
    process.on('exit', () => {
      child.kill();
      web.kill();
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } else {
    console.log(
      'usage: pnpm local check | migrate | invite [--uses N] | admin [user-id] | start [--no-ingest] [--no-build]',
    );
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
