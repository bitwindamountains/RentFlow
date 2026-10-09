import EmbeddedPostgres from '../scripts/disposable-postgres.mjs';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

/**
 * Every e2e suite runs against real PostgreSQL with the production migrations.
 * CI provides TEST_DATABASE_URL (a disposable service container); locally an
 * embedded server is started in a temporary directory and removed afterwards.
 */
export default async function setup(project: TestProject) {
  let stop: (() => Promise<void>) | undefined;
  let url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    const directory = await mkdtemp(join(tmpdir(), 'rentflow-test-pg-'));
    const port = 54_000 + Math.floor(Math.random() * 900);
    const postgres = new EmbeddedPostgres({
      databaseDir: directory,
      port,
      user: 'rentflow_test',
      password: 'rentflow_test',
      // Remove it ourselves with retries: Windows can briefly hold files after stop.
      persistent: true,
      onLog: () => undefined,
    });
    let started = false;
    stop = async () => {
      if (started) await postgres.stop();
      if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unexpected test database directory');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
    };
    try {
      await postgres.initialise();
      await postgres.start();
      started = true;
      await postgres.createDatabase('rentflow_test');
      url = `postgresql://rentflow_test:rentflow_test@127.0.0.1:${port}/rentflow_test`;
    } catch (error) {
      await stop();
      throw error;
    }
  }
  try {
    execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });
    project.provide('databaseUrl', url);
  } catch (error) {
    await stop?.();
    throw error;
  }
  return async () => {
    await stop?.();
  };
}
