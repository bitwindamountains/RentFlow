import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      persistent: false,
      onLog: () => undefined,
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase('rentflow_test');
    url = `postgresql://rentflow_test:rentflow_test@127.0.0.1:${port}/rentflow_test`;
    stop = async () => {
      await postgres.stop();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
    };
  }
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });
  project.provide('databaseUrl', url);
  return async () => {
    await stop?.();
  };
}
