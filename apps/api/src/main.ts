import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EnvError, loadDotEnv, parseEnv } from '@smc/config';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';

/** Last-resort handlers print the error class only: Node's default prints enumerable properties, bypassing redaction. */
function fatal(kind: string, error: unknown): never {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  process.stderr.write(`fatal ${kind}: ${name}\n`);
  process.exit(1);
}
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
process.on('uncaughtException', (error) => fatal('uncaughtException', error));

async function main(): Promise<void> {
  loadDotEnv();
  let env: ReturnType<typeof parseEnv>;
  try {
    env = parseEnv(process.env);
  } catch (error) {
    // EnvError lists variable names and failure kinds only, never values.
    process.stderr.write(`${error instanceof EnvError ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register({ env }), {
    bufferLogs: true,
  });
  configureApp(app, env);
  // Development listens on loopback only; production sits behind the tunnel on the container network.
  await app.listen(env.PORT, env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
}

await main();
