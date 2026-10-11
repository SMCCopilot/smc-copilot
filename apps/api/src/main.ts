import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EnvError, loadDotEnv, parseEnv } from '@smc/config';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';

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
  await app.listen(env.PORT, '0.0.0.0');
}

await main();
