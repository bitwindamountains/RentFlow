import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../src/billing/billing.service.js';
import { DEMO_RESTRICTED } from '../src/auth/decorators.js';
import { resetEnvironmentCache } from '../src/config/environment.js';
import { deleteDemoOrganization, deleteExpiredDemos } from '../src/demo/demo-cleanup.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { Client, lastEmail, prismaOf, registerOwner, routesOf, startApp, today } from './helpers.js';

/** Routes a demo workspace may not use: they send email, store files, export data, or change account security. */
const DEMO_RESTRICTED_EXPECTED = [
  'POST /auth/mfa/setup',
  'POST /auth/mfa/enable',
  'POST /auth/mfa/disable',
  'POST /auth/mfa/owner-requirement',
  'POST /auth/mfa/recovery-codes',
  'POST /auth/switch-workspace',
  'POST /auth/email/resend',
  'POST /auth/password',
  'POST /staff/invitations',
  'POST /tenants/:id/portal/invite',
  'POST /notifications/mail/:id/retry',
  'POST /documents',
  'POST /documents/files',
  'GET /tenants/:id/export',
  'POST /tenants/:id/erase',
];

/** Signed-in routes that change data and stay open in a demo. A new one fails the sweep until it is listed here or above. */
const DEMO_ALLOWED = [
  'POST /auth/logout',
  'POST /auth/sessions/revoke-others',
  'DELETE /auth/sessions/:id',
  'POST /billing-schedules',
  'POST /billing/run',
  'POST /charges',
  'POST /charges/:id/adjustments',
  'POST /charges/:id/void',
  'POST /payments',
  'POST /payments/:id/reverse',
  'POST /leases/:id/deposits',
  'POST /portal/maintenance',
  'POST /portal/payment-notices',
  'POST /portal/payment-notices/:id/withdraw',
  'POST /portal/payment-notices/:id/proof',
  'DELETE /tenants/:id/portal',
  'POST /payment-notices/:id/confirm',
  'POST /payment-notices/:id/reject',
  'POST /properties',
  'PATCH /properties/:id',
  'POST /properties/:id/units',
  'PATCH /units/:id',
  'POST /tenants',
  'PATCH /tenants/:id',
  'POST /tenants/:id/archive',
  'POST /leases',
  'POST /leases/:id/renew',
  'POST /leases/:id/rent-change',
  'POST /leases/:id/terminate',
  'POST /rental-setup',
  'DELETE /staff/invitations/:id',
  'PATCH /staff/:membershipId',
  'DELETE /staff/:membershipId',
  'POST /expenses',
  'POST /expenses/:id/void',
  'POST /maintenance',
  'PATCH /maintenance/:id',
  'PATCH /documents/:id/sharing',
  'DELETE /documents/:id',
];

const settings = ['DEMO_ENABLED', 'DEMO_MAX_ACTIVE'] as const;

describe('demo workspaces', () => {
  let app: NestFastifyApplication;
  const saved: Record<string, string | undefined> = {};

  const setEnv = (values: Partial<Record<(typeof settings)[number], string>>) => {
    for (const name of settings) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    resetEnvironmentCache();
  };
  const liveDemos = () => prismaOf(app).organization.count({ where: { demoExpiresAt: { gt: new Date() } } });
  /** Leaves room for `free` more demos under DEMO_MAX_ACTIVE. */
  const capWithRoom = async (free: number) => setEnv({ DEMO_ENABLED: 'true', DEMO_MAX_ACTIVE: String(Math.min(200, (await liveDemos()) + free)) });
  const startDemo = async () => {
    const client = new Client(app);
    const response = await client.post('/demo');
    return { client, response };
  };

  beforeAll(async () => {
    for (const name of settings) saved[name] = process.env[name];
    app = await startApp();
  });
  beforeEach(() => setEnv({ DEMO_ENABLED: 'true', DEMO_MAX_ACTIVE: '200' }));
  afterAll(async () => {
    for (const name of settings) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetEnvironmentCache();
    await app.close();
  });

  it('GET /demo reports enabled', async () => {
    expect((await new Client(app).get('/demo')).body).toEqual({ enabled: true });
  });

  it('creates a private, seeded demo and signs in', async () => {
    const { client, response } = await startDemo();
    expect(response.status).toBe(201);
    expect(response.body.role).toBe('OWNER');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    const expiresIn = Date.parse(response.body.organization.demoExpiresAt) - Date.now();
    expect(Math.abs(expiresIn - 24 * 3_600_000)).toBeLessThan(5 * 60_000);
    expect((await client.get('/auth/me')).body.organization.demoExpiresAt).toBe(response.body.organization.demoExpiresAt);

    const organizationId: string = response.body.organization.id;
    const prisma = prismaOf(app);
    expect(await prisma.property.count({ where: { organizationId } })).toBe(2);
    expect(await prisma.unit.count({ where: { organizationId } })).toBe(6);
    expect(await prisma.tenant.count({ where: { organizationId, status: 'ACTIVE' } })).toBe(5);
    expect(await prisma.lease.count({ where: { organizationId, status: 'ACTIVE' } })).toBe(5);
    const endingSoon = await prisma.lease.count({
      where: { organizationId, status: 'ACTIVE', endDate: { lte: new Date(Date.parse(today()) + 30 * 86_400_000) } },
    });
    expect(endingSoon).toBeGreaterThanOrEqual(1);
    expect(await prisma.depositTransaction.count({ where: { organizationId } })).toBe(1);
    expect(await prisma.expense.count({ where: { organizationId } })).toBe(1);
    expect(await prisma.maintenanceRequest.count({ where: { organizationId, status: 'OPEN' } })).toBe(1);

    const arrears = (await client.get('/arrears')).body as Array<{ tenantName: string; overdue: string }>;
    expect(arrears.map((row) => row.tenantName).sort()).toEqual(['Liza Garcia', 'Mark Bautista']);
    const leases = await prisma.lease.findMany({ where: { organizationId }, include: { primaryTenant: true } });
    const rentOf = (lastName: string) => Number(leases.find((lease) => lease.primaryTenant.lastName === lastName)!.monthlyRent);
    const overdueOf = (lastName: string) => Number(arrears.find((row) => row.tenantName.endsWith(` ${lastName}`))!.overdue);
    expect(overdueOf('Bautista')).toBeGreaterThan(0);
    expect(overdueOf('Bautista')).toBeLessThan(rentOf('Bautista'));
    expect(overdueOf('Garcia')).toBeGreaterThanOrEqual(rentOf('Garcia'));
  });

  it('recording a payment works in a demo', async () => {
    const { client, response } = await startDemo();
    const organizationId: string = response.body.organization.id;
    const lease = await prismaOf(app).lease.findFirstOrThrow({ where: { organizationId, primaryTenant: { lastName: 'Garcia' } } });
    const payment = await client.post(
      '/payments',
      { tenantId: lease.primaryTenantId, leaseId: lease.id, amount: '1000.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(payment.status).toBe(201);
    expect(payment.body.receipt?.receiptNumber ?? payment.body.receiptNumber).toMatch(/^DEMO/);
  });

  it('refuses when disabled', async () => {
    setEnv({ DEMO_ENABLED: 'false' });
    expect((await new Client(app).get('/demo')).body).toEqual({ enabled: false });
    const { response } = await startDemo();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DEMO_UNAVAILABLE');
  });

  it('refuses at the cap', async () => {
    await capWithRoom(2);
    expect((await startDemo()).response.status).toBe(201);
    expect((await startDemo()).response.status).toBe(201);
    const refused = (await startDemo()).response;
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('DEMO_UNAVAILABLE');
  });

  it('parallel creates at the cap stay within the in-flight requests', async () => {
    await capWithRoom(1);
    const before = await liveDemos();
    const results = await Promise.all([startDemo(), startDemo(), startDemo()]);
    const statuses = results.map((result) => result.response.status);
    expect(statuses.sort()).toEqual([201, 503, 503]);
    expect(await liveDemos()).toBe(before + 1);
  });

  it('a failed seed leaves no demo behind', async () => {
    const before = await liveDemos();
    const spy = vi.spyOn(BillingService.prototype, 'runBilling').mockRejectedValueOnce(new Error('seed failure'));
    try {
      expect((await startDemo()).response.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await liveDemos()).toBe(before);
    expect(await prismaOf(app).organization.count({ where: { demoExpiresAt: { not: null }, properties: { none: {} } } })).toBe(0);
  });

  it('demo workspaces are isolated from real ones', async () => {
    const { client: owner } = await registerOwner(app);
    const tenant = await owner.post('/tenants', { firstName: 'Real', lastName: 'Person' });
    expect(tenant.status).toBe(201);
    const { client } = await startDemo();
    expect((await client.get(`/tenants/${tenant.body.id}`)).status).toBe(404);
  });
it('every route is classified for demo mode', async () => {
    const routes = routesOf(app, DEMO_RESTRICTED);
    const mutating = routes
      .filter((route) => !route.isPublic && (route.method !== 'GET' || route.key === 'GET /tenants/:id/export'))
      .map((route) => route.key);
    expect(DEMO_RESTRICTED_EXPECTED.filter((key) => DEMO_ALLOWED.includes(key))).toEqual([]);
    expect(mutating.filter((key) => !DEMO_RESTRICTED_EXPECTED.includes(key) && !DEMO_ALLOWED.includes(key))).toEqual([]);
    expect([...DEMO_RESTRICTED_EXPECTED, ...DEMO_ALLOWED].filter((key) => !mutating.includes(key))).toEqual([]);
    expect(routes.filter((route) => route.flagged).map((route) => route.key).sort()).toEqual([...DEMO_RESTRICTED_EXPECTED].sort());
  });

  it('restricted routes refuse a demo session', async () => {
    const { client } = await startDemo();
    for (const key of DEMO_RESTRICTED_EXPECTED) {
      const [method, template] = key.split(' ') as ['GET' | 'POST', string];
      const path = template.replace(/:[A-Za-z]+/g, crypto.randomUUID());
      const response = await client.request(method, path, method === 'GET' ? undefined : {});
      expect([response.status, response.body?.code], key).toEqual([403, 'DEMO_RESTRICTED']);
    }
  });

  it('restricted routes still work for real workspaces', async () => {
    const { client } = await registerOwner(app);
    const invite = await client.post('/staff/invitations', { email: `staff-${crypto.randomUUID()}@example.com`, role: 'VIEWER' });
    expect(invite.status).toBe(201);
  });

  it('no mail leaves a demo', async () => {
    const { client, response } = await startDemo();
    const organizationId: string = response.body.organization.id;
    const prisma = prismaOf(app);
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { organizationId, lastName: 'Garcia' } });
    const lease = await prisma.lease.findFirstOrThrow({ where: { organizationId, primaryTenantId: tenant.id } });
    const realAddress = `real-${crypto.randomUUID()}@example.com`;
    expect((await client.patch(`/tenants/${tenant.id}`, { firstName: tenant.firstName, lastName: tenant.lastName, email: realAddress })).status).toBe(200);
    expect((await client.post(`/tenants/${tenant.id}/portal/invite`)).status).toBe(403);
    const payment = await client.post(
      '/payments',
      { tenantId: tenant.id, leaseId: lease.id, amount: '500.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(payment.status).toBe(201);
    await app.get(JobsService).runAll();
    expect(await prisma.mailDelivery.count({ where: { organizationId } })).toBe(0);
    expect(lastEmail(app, realAddress)).toBeUndefined();
    const demoOwner = await prisma.membership.findFirstOrThrow({ where: { organizationId }, include: { user: true } });
    expect(lastEmail(app, demoOwner.user.email)).toBeUndefined();
  });
/** Ends a demo's time without waiting 24 hours. */
  const expire = (organizationId: string) =>
    prismaOf(app).organization.update({ where: { id: organizationId }, data: { demoExpiresAt: new Date(Date.now() - 60_000) } });
  /** Rows left for an organization in every table that has an "organizationId" column. */
  const leftovers = async (organizationId: string) => {
    const prisma = prismaOf(app);
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE column_name = 'organizationId' AND table_schema = current_schema()`;
    const counts: Record<string, number> = {};
    for (const { table_name } of tables) {
      const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM "${table_name}" WHERE "organizationId" = $1::uuid`,
        organizationId,
      );
      if (Number(row!.count) > 0) counts[table_name] = Number(row!.count);
    }
    return counts;
  };

  it('expired demos are deleted with every row', async () => {
    const { client, response } = await startDemo();
    const organizationId: string = response.body.organization.id;
    const prisma = prismaOf(app);
    const lease = await prisma.lease.findFirstOrThrow({ where: { organizationId, primaryTenant: { lastName: 'Garcia' } } });
    const payment = await client.post(
      '/payments',
      { tenantId: lease.primaryTenantId, leaseId: lease.id, amount: '700.00', method: 'GCASH', paidAt: new Date().toISOString(), allocations: [] },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(payment.status).toBe(201);
    expect((await client.post(`/payments/${payment.body.id}/reverse`, { reason: 'Entered twice' })).status).toBe(201);
    const ownerId = (await prisma.membership.findFirstOrThrow({ where: { organizationId } })).userId;

    await expire(organizationId);
    expect(await deleteExpiredDemos(prisma)).toBeGreaterThanOrEqual(1);
    expect(await leftovers(organizationId)).toEqual({});
    expect(await prisma.organization.findUnique({ where: { id: organizationId } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: ownerId } })).toBeNull();
  });

  it('a real workspace is never deleted', async () => {
    const { client, profile } = await registerOwner(app);
    expect((await client.post('/tenants', { firstName: 'Kept', lastName: 'Safe' })).status).toBe(201);
    const prisma = prismaOf(app);
    expect(await deleteDemoOrganization(prisma, profile.organization.id)).toBe(false);
    expect(await prisma.tenant.count({ where: { organizationId: profile.organization.id } })).toBe(1);
    expect(await prisma.organization.findUnique({ where: { id: profile.organization.id } })).not.toBeNull();
  });

  it('live demos are kept', async () => {
    const { response } = await startDemo();
    await deleteExpiredDemos(prismaOf(app));
    expect(await prismaOf(app).organization.findUnique({ where: { id: response.body.organization.id } })).not.toBeNull();
  });

  it('a session in a deleted demo gets 401', async () => {
    const { client, response } = await startDemo();
    await expire(response.body.organization.id);
    await deleteExpiredDemos(prismaOf(app));
    const after = await client.get('/dashboard');
    expect(after.status).toBe(401);
  });

  it('an expired demo stops working before the job deletes it', async () => {
    const { client, response } = await startDemo();
    await expire(response.body.organization.id);
    expect((await client.get('/dashboard')).status).toBe(401);
  });

  it('signing out of a demo deletes it and frees its slot', async () => {
    const { client, response } = await startDemo();
    const before = await liveDemos();
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect(await prismaOf(app).organization.findUnique({ where: { id: response.body.organization.id } })).toBeNull();
    expect(await liveDemos()).toBe(before - 1);
  });

  it('one demo that cannot be deleted does not stop the job', async () => {
    const prisma = prismaOf(app);
    const stuck = (await startDemo()).response.body.organization.id as string;
    const other = (await startDemo()).response.body.organization.id as string;
    await expire(stuck);
    await expire(other);
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION test_block_demo_delete() RETURNS trigger AS $$ BEGIN IF OLD.id = '${stuck}' THEN RAISE EXCEPTION 'blocked'; END IF; RETURN OLD; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_block_demo_delete BEFORE DELETE ON "Organization" FOR EACH ROW EXECUTE FUNCTION test_block_demo_delete()',
    );
    try {
      await expect(app.get(JobsService).runAll()).resolves.toBeDefined();
      expect(await prisma.organization.findUnique({ where: { id: other } })).toBeNull();
      expect(await prisma.organization.findUnique({ where: { id: stuck } })).not.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_block_demo_delete ON "Organization"');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_block_demo_delete()');
      await deleteDemoOrganization(prisma, stuck);
    }
  });

  it('the job tick removes expired demos', async () => {
    const { response } = await startDemo();
    await expire(response.body.organization.id);
    await app.get(JobsService).runAll();
    expect(await prismaOf(app).organization.findUnique({ where: { id: response.body.organization.id } })).toBeNull();
  });
});


