import EmbeddedPostgres from 'embedded-postgres';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const databaseDir = resolve('.data/postgres');
const database = 'rentflow';
const postgres = new EmbeddedPostgres({
  databaseDir,
  user: 'rentflow',
  password: 'rentflow_dev_password',
  port: 5432,
  persistent: true,
});

try {
  await access(databaseDir);
} catch {
  await postgres.initialise();
}

await postgres.start();
try {
  await postgres.createDatabase(database);
} catch (error) {
  if (!String(error).includes('already exists')) throw error;
}

console.log(`PostgreSQL ready at postgresql://rentflow:rentflow_dev_password@127.0.0.1:5432/${database}`);
console.log('Keep this process running; press Ctrl+C to stop PostgreSQL.');
await new Promise(() => {});
