import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresConnection } from './backup.mjs';

const base = 'postgresql://rentflow.ref:s3cret@aws-0-ap.pooler.supabase.com:5432/postgres?schema=rentflow&connection_limit=5';

test('keeps Prisma-only options and the password out of the libpq URL', () => {
  const { url, schema, env } = postgresConnection(`${base}&sslmode=require`);
  assert.equal(url, 'postgresql://rentflow.ref@aws-0-ap.pooler.supabase.com:5432/postgres?sslmode=require');
  assert.equal(schema, 'rentflow');
  assert.equal(env.PGPASSWORD, 's3cret');
});

test('strict TLS verifies the server with the given CA, or the system store', () => {
  const withCa = new URL(postgresConnection(`${base}&sslmode=require&sslaccept=strict&sslcert=/etc/rentflow/db-certs/ca.crt`).url);
  assert.equal(withCa.searchParams.get('sslmode'), 'verify-full');
  assert.equal(withCa.searchParams.get('sslrootcert'), '/etc/rentflow/db-certs/ca.crt');
  // libpq's sslcert is a client certificate, so Prisma's must not pass through.
  assert.equal(withCa.searchParams.get('sslcert'), null);
  const system = new URL(postgresConnection(`${base}&sslmode=require&sslaccept=strict`).url);
  assert.equal(system.searchParams.get('sslmode'), 'verify-full');
  assert.equal(system.searchParams.get('sslrootcert'), 'system');
});
