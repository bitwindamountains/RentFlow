import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Prisma pool/schema options are not libpq options. Keep the password out of process arguments. */
export function postgresConnection(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('A PostgreSQL DATABASE_URL is required');
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  const schema = url.searchParams.get('schema') || 'public';
  url.password = '';
  for (const option of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size', 'socket_timeout', 'sslaccept'])
    url.searchParams.delete(option);
  return { url: url.toString(), schema, env:{ ...process.env, ...(password !== undefined ? { PGPASSWORD: password } : {}) } };
}

export async function backupDatabase({ databaseUrl, directory = resolve('backups'), pgDump = 'pg_dump', pgRestore = 'pg_restore' }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const connection = postgresConnection(databaseUrl);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const target = resolve(directory, `rentflow-${stamp}-${randomUUID()}.dump`);
  const temporary = `${target}.partial`;
  try {
    await writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    // Only the app's own schema: on a shared database (e.g. Supabase) other schemas are not readable.
    await execute(pgDump, ['--format=custom', '--no-owner', `--schema=${connection.schema}`, '--file', temporary, '--dbname', connection.url], { env: connection.env, windowsHide: true });
    if (!(await stat(temporary)).size) throw new Error('pg_dump produced an empty backup');
    await execute(pgRestore, ['--list', temporary], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const target = await backupDatabase({
      databaseUrl: process.env.DATABASE_URL,
      directory: process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : undefined,
      pgDump: process.env.PG_DUMP_PATH || 'pg_dump',
      pgRestore: process.env.PG_RESTORE_PATH || 'pg_restore',
    });
    console.log(`Backup written and archive verified: ${target}`);
  } catch (error) {
    // Never print a connection string or child-process arguments in operator logs.
    console.error(`Backup failed (${error.code ?? error.name ?? 'Error'}). No completed backup was published.`);
    process.exitCode = 1;
  }
}
