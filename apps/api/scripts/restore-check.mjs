// A destructive restore is performed only into databases this script creates in a disposable local cluster.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from './disposable-postgres.mjs';
import { backupDatabase, postgresConnection } from './backup.mjs';

const execute = promisify(execFile);
const apiDir = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(apiDir, '../..');
const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
const pgRestore = process.env.PG_RESTORE_PATH || 'pg_restore';
const tar = process.env.TAR_PATH || 'tar';
// Fail before creating a cluster if the backup tools or production build are absent.
const version = (await execute(pgDump, ['--version'], { windowsHide: true })).stdout.trim();
await execute(pgRestore, ['--version'], { windowsHide: true });
await execute(tar, ['--version'], { windowsHide: true });
await readFile(join(apiDir, 'dist/bootstrap.js'));
const scratch = await mkdtemp(join(tmpdir(), 'rentflow-restore-check-'));
let postgres;
let app;
let sql;

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

async function migrate(schema, url) {
  await execute(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', schema], {
    cwd: apiDir, env: { ...process.env, DATABASE_URL: url }, windowsHide: true,
  });
}

function client(application) {
  return {
    cookie: '', csrf: '',
    async request(method, path, body, headers = {}, expected = 200) {
      const reply = await application.inject({ method, url: `/api/v1${path}`, payload: body,
        headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...headers },
      });
      assert.equal(reply.statusCode, expected, `${method} ${path}: ${reply.body}`);
      if (reply.headers['set-cookie']) this.cookie = String(reply.headers['set-cookie']).split(';')[0];
      const result = String(reply.headers['content-type']).includes('application/json') ? reply.json() : reply.rawPayload;
      if (result.csrfToken) this.csrf = result.csrfToken;
      return result;
    },
    get(path) { return this.request('GET', path); },
    post(path, body, key) { return this.request('POST', path, body, key ? { 'idempotency-key': key } : {}, 201); },
  };
}

try {
  const port = await freePort();
  postgres = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), port, user: 'restore_check', password: randomBytes(24).toString('hex'), persistent: true, onLog: () => undefined });
  // Access credentials only through a client supplied by the disposable cluster.
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('rentflow_source');
  sql = postgres.getPgClient('rentflow_source');
  await sql.connect();
  const sourceUrl = new URL(`postgresql://restore_check@127.0.0.1:${port}/rentflow_source`);
  sourceUrl.password = sql.connectionParameters.password;
  sourceUrl.searchParams.set('schema', 'public');
  sourceUrl.searchParams.set('connection_limit', '4');
  const sourceFiles = join(scratch, 'source', 'uploads');
  const restoredFiles = join(scratch, 'restored', 'uploads');
  const encryptionKey = randomBytes(32).toString('base64');
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: sourceUrl.toString(), WEB_ORIGIN: 'http://localhost:4200', APP_URL: 'http://localhost:4200',
    MAIL_PROVIDER: 'log', MAIL_ENCRYPTION_KEY: encryptionKey, ENABLE_JOBS: 'false', RATE_LIMIT_MULTIPLIER: '1000',
    STORAGE_DRIVER: 'local', STORAGE_DIR: sourceFiles, LOG_LEVEL: 'error',
  });

  // First reproduce an upgrade from the schema before this review's four migrations.
  const previous = join(scratch, 'previous-prisma');
  await mkdir(join(previous, 'migrations'), { recursive: true });
  await cp(join(apiDir, 'prisma/schema.prisma'), join(previous, 'schema.prisma'));
  await cp(join(apiDir, 'prisma/migrations/migration_lock.toml'), join(previous, 'migrations/migration_lock.toml'));
  for (const entry of await readdir(join(apiDir, 'prisma/migrations'), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name < '20261009090000')
      await cp(join(apiDir, 'prisma/migrations', entry.name), join(previous, 'migrations', entry.name), { recursive: true });
  }
  await migrate(join(previous, 'schema.prisma'), sourceUrl.toString());
  const legacyOrg = randomUUID();
  const actor = randomUUID();
  const retainedId = randomUUID();
  const removedId = randomUUID();
  const retainedKey = `${legacyOrg}/${retainedId}.pdf`;
  const removedKey = `${legacyOrg}/${removedId}.pdf`;
  const pdf = Buffer.from('%PDF-1.7\nRentFlow restore check\n%%EOF');
  const hash = createHash('sha256').update(pdf).digest('hex');
  await sql.query('INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ($1, $2, $3, now())', [legacyOrg, 'Legacy restore check', `legacy-${legacyOrg}`]);
  for (const [id, key, deletedAt] of [[retainedId, retainedKey, null], [removedId, removedKey, new Date()]]) {
    await sql.query('INSERT INTO "DocumentRecord" (id, "organizationId", name, category, "storageKey", "contentType", "sizeBytes", sha256, "createdBy", "deletedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, legacyOrg, 'Legacy document', 'Lease', key, 'application/pdf', pdf.length, hash, actor, deletedAt]);
    await mkdir(dirname(join(sourceFiles, key)), { recursive: true });
    await writeFile(join(sourceFiles, key), pdf);
  }
  const legacyOperation = randomUUID();
  await sql.query('INSERT INTO "IdempotencyKey" (id, "organizationId", key, operation, "requestHash", "expiresAt") VALUES ($1,$2,$3,$4,$5,$6)',
    [legacyOperation, legacyOrg, 'old-operation', 'RESTORE_TEST', 'legacy-hash', new Date(0)]);
  const { createApp } = await import('../dist/bootstrap.js');
  const { resetEnvironmentCache } = await import('../dist/config/environment.js');
  const { PrismaService } = await import('../dist/common/prisma.service.js');
  const { MailerService } = await import('../dist/mail/mailer.service.js');
  const { StorageService } = await import('../dist/storage/storage.service.js');
  const { todayInZone } = await import('../dist/common/dates.js');
  async function start(url, files) {
    process.env.DATABASE_URL = url;
    process.env.STORAGE_DIR = files;
    resetEnvironmentCache();
    app = await createApp({ logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }
  await start(sourceUrl.toString(), sourceFiles);
  assert.equal((await app.inject({ url: '/api/v1/health/ready' })).statusCode, 503);
  await app.close(); app = undefined;
  await migrate(join(apiDir, 'prisma/schema.prisma'), sourceUrl.toString());
  await start(sourceUrl.toString(), sourceFiles);
  let db = app.get(PrismaService);
  assert.equal((await db.idempotencyKey.findUniqueOrThrow({ where: { id: legacyOperation } })).expiresAt, null);
  assert.equal((await db.storageObject.findUniqueOrThrow({ where: { key: retainedKey } })).state, 'READY');
  assert.equal((await db.storageObject.findUniqueOrThrow({ where: { key: removedKey } })).state, 'DELETE_PENDING');
  console.log('PASS: populated legacy schema upgrades, storage backfill and readiness gate');

  let owner = client(app);
  await owner.get('/health/ready');
  const profile = await owner.post('/auth/register', { email: 'restore-owner@example.test', password: 'local restore test password', name: 'Restore Owner', organizationName: 'Restore Workspace' });
  await app.get(MailerService).processPending();
  const property = await owner.post('/properties', { name: 'Restore Building', type: 'Apartment', address: '1 Test Street', city: 'Cebu City' });
  const unit = await owner.post(`/properties/${property.id}/units`, { number: '1A', type: 'Studio', monthlyRent: '1000.00' });
  const tenant = await owner.post('/tenants', { firstName: 'Restore', lastName: 'Tenant', email: 'restore-tenant@example.test', phone: '+639170000001' });
  const today = todayInZone('Asia/Manila');
  const lease = await owner.post('/leases', { unitId: unit.id, tenantId: tenant.id, startDate: today, monthlyRent: '1000.00', billingDay: 1, dueDay: 5, firstMonth: 'FULL' });
  const paymentInput = { tenantId: tenant.id, leaseId: lease.id, amount: '1500.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] };
  const paymentKey = randomUUID();
  const payment = await owner.post('/payments', paymentInput, paymentKey);
  const document = await owner.request('POST', `/documents/files?name=Signed%20lease&category=Lease&entityType=Tenant&entityId=${tenant.id}`, pdf, { 'content-type': 'application/pdf' }, 201);
  const receipt = await owner.get(`/payments/${payment.id}/receipt`);
  const balances = await owner.get('/collections/options');
  const counts = { payments: await db.payment.count(), ledger: await db.ledgerEntry.count(), allocations: await db.paymentAllocation.count(), audits: await db.auditLog.count() };
  const queuedId = await db.$transaction(tx => app.get(MailerService).enqueue(tx, { to: 'restore-owner@example.test', subject: 'Restored mail', text: 'Encrypted message survives backup.' }, 'RESTORE_CHECK', { organizationId: profile.organization.id }));
  const saved = { cookie: owner.cookie, csrf: owner.csrf };
  await app.close(); app = undefined;
  await sql.end(); sql = undefined;

  const backups = join(scratch, 'backups');
  const dump = await backupDatabase({ databaseUrl: sourceUrl.toString(), directory: backups, pgDump, pgRestore });
  const archive = join(backups, 'uploads.tar.gz');
  await execute(tar, ['-czf', archive, '-C', dirname(sourceFiles), 'uploads'], { windowsHide: true });
  await postgres.createDatabase('rentflow_restored');
  const restoredUrl = new URL(sourceUrl);
  restoredUrl.pathname = '/rentflow_restored';
  const connection = postgresConnection(restoredUrl.toString());
  await execute(pgRestore, ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--dbname', connection.url, dump], { env: connection.env, windowsHide: true });
  await mkdir(dirname(restoredFiles), { recursive: true });
  await execute(tar, ['-xzf', archive, '-C', dirname(restoredFiles)], { windowsHide: true });
  await start(restoredUrl.toString(), restoredFiles);
  owner = Object.assign(client(app), saved);
  db = app.get(PrismaService);
  assert.equal((await owner.get('/auth/me')).user.id, profile.user.id);
  await owner.get('/health/ready');
  assert.deepEqual(await owner.get('/collections/options'), balances);
  assert.deepEqual(await owner.get(`/payments/${payment.id}/receipt`), receipt);
  assert.deepEqual(await owner.get(`/documents/${document.id}/file`), pdf);
  assert.deepEqual(await owner.post('/payments', paymentInput, paymentKey), payment);
  assert.deepEqual({ payments: await db.payment.count(), ledger: await db.ledgerEntry.count(), allocations: await db.paymentAllocation.count(), audits: await db.auditLog.count() }, counts);
  const next = await owner.post('/payments', { ...paymentInput, amount: '1.00' }, randomUUID());
  assert.equal(Number(next.receiptNumber.split('-').at(-1)), Number(payment.receiptNumber.split('-').at(-1)) + 1);
  console.log('PASS: archive restore preserves balances, receipts, files, session and idempotency; receipt numbering continues');

  await app.get(MailerService).processPending();
  assert.ok(app.get(MailerService).outbox.some(message => message.text === 'Encrypted message survives backup.'));
  assert.equal((await db.mailDelivery.findUniqueOrThrow({ where: { id: queuedId } })).encryptedBody, null);
  await app.get(StorageService).processPending();
  assert.equal((await db.storageObject.findUniqueOrThrow({ where: { key: removedKey } })).state, 'DELETED');
  await assert.rejects(readFile(join(restoredFiles, removedKey)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(restoredFiles, retainedKey)), pdf);
  console.log('PASS: encrypted mail and pending file cleanup recover using the restored database and key');

  const failureDir = join(scratch, 'failed-backup');
  const missing = new URL(sourceUrl); missing.pathname = '/does_not_exist';
  await assert.rejects(backupDatabase({ databaseUrl: missing.toString(), directory: failureDir, pgDump, pgRestore }));
  assert.deepEqual(await readdir(failureDir), []);
  await assert.rejects(backupDatabase({ databaseUrl: sourceUrl.toString(), directory: failureDir, pgDump, pgRestore: join(scratch, 'missing-pg-restore') }));
  assert.deepEqual(await readdir(failureDir), []);
  console.log('PASS: failed dump and failed archive verification leave no published or partial backup');
  console.log(`Local restore drill completed (${version}); all data was disposable.`);
} finally {
  await app?.close();
  await sql?.end();
  await postgres?.stop();
  // Never recursively remove a computed path without checking its resolved parent and prefix.
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
  assert.ok(basename(scratch).startsWith('rentflow-restore-check-'));
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
