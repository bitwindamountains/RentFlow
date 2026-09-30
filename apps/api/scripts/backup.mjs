import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const directory = resolve('backups');
await mkdir(directory, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const target = resolve(directory, `rentflow-${stamp}.dump`);
const output = createWriteStream(target, { flags: 'wx' });
const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--dbname', databaseUrl], { stdio: ['ignore', 'pipe', 'inherit'], shell: false });
child.stdout.pipe(output);
const exitCode = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode); });
if (exitCode !== 0) throw new Error(`pg_dump exited with code ${exitCode}`);
console.log(`Backup written to ${target}`);
