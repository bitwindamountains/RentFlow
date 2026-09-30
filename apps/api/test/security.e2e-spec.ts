import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  createRental,
  PASSWORD,
  prismaOf,
  registerOwner,
  startApp,
  today,
  unique,
} from './helpers.js';

describe('authorization and tenancy isolation', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let intruder: Client;
  let rental: Awaited<ReturnType<typeof createRental>>;
  let chargeId: string;
  let paymentId: string;
  let expenseId: string;
  let maintenanceId: string;
  let documentId: string;

  async function member(role: string) {
    const email = `${role.toLowerCase()}-${unique()}@rentflow.test`;
    const invite = await owner.post('/staff/invitations', { email, role });
    await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: `${role} person`, password: PASSWORD });
    const client = new Client(app);
    await client.post('/auth/login', { email, password: PASSWORD });
    return { client, email, invitationId: invite.body.id as string };
  }

  beforeAll(async () => {
    app = await startApp();
    owner = (await registerOwner(app)).client;
    intruder = (await registerOwner(app)).client;
    rental = await createRental(owner);
    chargeId = (await owner.get(`/leases/${rental.lease.id}/open-charges`)).body[0].id;
    paymentId = (
      await owner.post('/payments', {
        tenantId: rental.tenant.id,
        leaseId: rental.lease.id,
        amount: '100.00',
        method: 'CASH',
        paidAt: new Date().toISOString(),
        allocations: [{ chargeId, amount: '100.00' }],
      })
    ).body.id;
    expenseId = (
      await owner.post('/expenses', {
        propertyId: rental.property.id,
        category: 'REPAIR',
        description: 'Door lock',
        amount: '500.00',
        incurredOn: today(),
      })
    ).body.id;
    maintenanceId = (
      await owner.post('/maintenance', {
        propertyId: rental.property.id,
        unitId: rental.unit.id,
        title: 'Leak',
        description: 'Kitchen sink',
        priority: 'HIGH',
      })
    ).body.id;
    documentId = (
      await owner.post('/documents', {
        name: 'Lease',
        category: 'Lease',
        entityType: 'Tenant',
        entityId: rental.tenant.id,
        url: 'https://files.example.com/lease.pdf',
      })
    ).body.id;
  });
  afterAll(async () => app.close());

  it('never exposes or mutates another organization’s records by id (IDOR)', async () => {
    const reads = [
      `/tenants/${rental.tenant.id}`,
      `/leases/${rental.lease.id}/ledger`,
      `/leases/${rental.lease.id}/open-charges`,
      `/payments/${paymentId}/receipt`,
    ];
    for (const path of reads) {
      const response = await intruder.get(path);
      expect([403, 404], path).toContain(response.status);
      expect(response.text, path).not.toContain(rental.tenant.lastName);
    }
    const writes: Array<[string, 'POST' | 'PATCH' | 'DELETE', unknown]> = [
      [`/properties/${rental.property.id}`, 'PATCH', { name: 'Hijacked', type: 'Apartment', address: 'Nowhere 1', city: 'X City' }],
      [`/properties/${rental.property.id}/units`, 'POST', { number: 'Z9', type: 'Studio', monthlyRent: '1.00' }],
      [`/units/${rental.unit.id}`, 'PATCH', { number: 'Z9', type: 'Studio', monthlyRent: '1.00' }],
      [`/tenants/${rental.tenant.id}`, 'PATCH', { firstName: 'Hijacked', lastName: 'X' }],
      [`/tenants/${rental.tenant.id}/archive`, 'POST', {}],
      [`/leases/${rental.lease.id}/renew`, 'POST', { endDate: '2099-01-01' }],
      [`/leases/${rental.lease.id}/rent-change`, 'POST', { effectiveFrom: '2099-01-01', monthlyRent: '1.00' }],
      [`/leases/${rental.lease.id}/terminate`, 'POST', { endDate: today(), reason: 'Hijack' }],
      [`/leases/${rental.lease.id}/deposits`, 'POST', { type: 'RECEIPT', amount: '1.00' }],
      ['/charges', 'POST', { leaseId: rental.lease.id, type: 'OTHER', description: 'Fake', amount: '1.00', dueDate: today() }],
      [`/charges/${chargeId}/adjustments`, 'POST', { type: 'WAIVER', amount: '1.00', reason: 'Hijack' }],
      [`/charges/${chargeId}/void`, 'POST', { reason: 'Hijack' }],
      ['/payments', 'POST', { tenantId: rental.tenant.id, leaseId: rental.lease.id, amount: '1.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] }],
      [`/payments/${paymentId}/reverse`, 'POST', { reason: 'Hijack' }],
      ['/leases', 'POST', { unitId: rental.unit.id, tenantId: rental.tenant.id, startDate: today(), monthlyRent: '1.00', billingDay: 1, dueDay: 1 }],
      ['/billing-schedules', 'POST', { leaseId: rental.lease.id, type: 'WATER', description: 'Water', amount: '1.00', billingDay: 1, dueDay: 1, startsOn: today() }],
      ['/expenses', 'POST', { propertyId: rental.property.id, category: 'REPAIR', description: 'Fake', amount: '1.00', incurredOn: today() }],
      [`/expenses/${expenseId}/void`, 'POST', { reason: 'Hijack' }],
      ['/maintenance', 'POST', { propertyId: rental.property.id, title: 'Fake', description: 'Fake one', priority: 'LOW' }],
      [`/maintenance/${maintenanceId}`, 'PATCH', { status: 'CANCELLED' }],
      ['/documents', 'POST', { name: 'Fake', category: 'Lease', entityType: 'Tenant', entityId: rental.tenant.id, url: 'https://evil.example.com/x' }],
      [`/documents/${documentId}`, 'DELETE', undefined],
    ];
    for (const [path, method, body] of writes) {
      const response = await intruder.request(method, path, body);
      expect([403, 404], `${method} ${path} → ${response.status} ${response.text}`).toContain(response.status);
    }
    // Nothing leaked into the intruder's own lists either.
    for (const path of ['/tenants', '/leases', '/charges', '/payments', '/expenses', '/maintenance', '/documents', '/arrears'])
      expect((await intruder.get(path)).text, path).not.toContain(rental.tenant.id);
    // The owner's data is unchanged.
    const tenant = (await owner.get(`/tenants/${rental.tenant.id}`)).body;
    expect(tenant.firstName).toBe('Tenant');
    expect(tenant.leases[0].status).toBe('ACTIVE');
  });

  it('rejects malformed ids with 400 instead of a server error', async () => {
    expect((await owner.get('/tenants/not-a-uuid')).status).toBe(400);
    expect((await owner.post('/payments/1%27%20OR%201=1/reverse', { reason: 'SQL test' })).status).toBe(400);
  });

  it('blocks cross-organization references at the database level', async () => {
    const other = await createRental(intruder);
    const prisma = prismaOf(app);
    await expect(
      prisma.charge.create({
        data: {
          organizationId: other.property.organizationId ?? (await prisma.lease.findUniqueOrThrow({ where: { id: other.lease.id } })).organizationId,
          leaseId: rental.lease.id,
          type: 'OTHER',
          description: 'cross-tenant',
          amount: '1',
          dueDate: new Date(),
          status: 'POSTED',
        },
      }),
    ).rejects.toThrow(/CROSS_ORGANIZATION_REFERENCE/);
  });

  it('enforces roles on the server, not only in the UI', async () => {
    const viewer = await member('VIEWER');
    const collector = await member('COLLECTOR');
    const maintenance = await member('MAINTENANCE');
    const manager = await member('MANAGER');

    expect((await viewer.client.get('/payments')).status).toBe(200);
    expect((await viewer.client.post('/tenants', { firstName: 'No', lastName: 'Way' })).status).toBe(403);
    expect(
      (await viewer.client.post('/payments', { tenantId: rental.tenant.id, leaseId: rental.lease.id, amount: '1.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] })).status,
    ).toBe(403);

    expect(
      (await collector.client.post('/payments', { tenantId: rental.tenant.id, leaseId: rental.lease.id, amount: '1.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] })).status,
    ).toBe(201);
    expect((await collector.client.post(`/charges/${chargeId}/void`, { reason: 'Not allowed' })).status).toBe(403);
    expect((await collector.client.post(`/payments/${paymentId}/reverse`, { reason: 'Not allowed' })).status).toBe(403);

    for (const path of ['/tenants', '/payments', '/charges', '/documents', '/reports/financial', '/dashboard'])
      expect((await maintenance.client.get(path)).status, path).toBe(403);
    const properties = (await maintenance.client.get('/properties')).body;
    expect(Object.keys(properties[0]).sort()).toEqual(['id', 'name', 'units']);
    expect((await maintenance.client.patch(`/maintenance/${maintenanceId}`, { status: 'IN_PROGRESS' })).status).toBe(200);

    expect((await manager.client.get('/staff')).status).toBe(403);
    expect((await manager.client.post('/staff/invitations', { email: `x-${unique()}@t.test`, role: 'VIEWER' })).status).toBe(403);
    expect((await manager.client.get('/audit-log')).status).toBe(200);
  });

  it('revokes access immediately when an owner suspends or removes staff', async () => {
    const staff = await member('COLLECTOR');
    const list = (await owner.get('/staff')).body.members;
    const membership = list.find((item: { email: string }) => item.email === staff.email);
    expect((await owner.patch(`/staff/${membership.id}`, { status: 'SUSPENDED' })).status).toBe(200);
    expect((await staff.client.get('/payments')).status).toBe(401);
    expect((await new Client(app).post('/auth/login', { email: staff.email, password: PASSWORD })).status).toBe(401);

    expect((await owner.patch(`/staff/${membership.id}`, { status: 'ACTIVE', role: 'VIEWER' })).status).toBe(200);
    const again = new Client(app);
    expect((await again.post('/auth/login', { email: staff.email, password: PASSWORD })).body.role).toBe('VIEWER');

    expect((await owner.delete(`/staff/${membership.id}`)).status).toBe(200);
    expect((await again.get('/payments')).status).toBe(401);
    expect((await owner.get('/staff')).body.members.some((item: { email: string }) => item.email === staff.email)).toBe(false);
  });

  it('protects the owner and prevents self-demotion or OWNER grants', async () => {
    const list = (await owner.get('/staff')).body.members;
    const self = list.find((item: { role: string }) => item.role === 'OWNER');
    expect((await owner.patch(`/staff/${self.id}`, { status: 'SUSPENDED' })).status).toBe(422);
    const staff = await member('VIEWER');
    const target = (await owner.get('/staff')).body.members.find((item: { email: string }) => item.email === staff.email);
    expect((await owner.patch(`/staff/${target.id}`, { role: 'OWNER' })).status).toBe(422);
    expect((await owner.post('/staff/invitations', { email: `o-${unique()}@t.test`, role: 'OWNER' })).status).toBe(422);
  });

  it('lets an owner cancel a pending invitation', async () => {
    const invite = await owner.post('/staff/invitations', { email: `cancel-${unique()}@t.test`, role: 'VIEWER' });
    expect((await owner.delete(`/staff/invitations/${invite.body.id}`)).status).toBe(200);
    const accept = await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: 'Late', password: PASSWORD });
    expect(accept.status).toBe(400);
    expect(accept.body.code).toBe('INVITATION_INVALID');
  });

  it('keeps personal data out of the audit log', async () => {
    const rows = await prismaOf(app).auditLog.findMany({ where: { entityType: 'Tenant', entityId: rental.tenant.id } });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(rental.tenant.email);
    expect(JSON.stringify(rows)).not.toContain('+63 917');
  });

  it('sets security headers and a request id on API responses', async () => {
    const response = await owner.get('/dashboard');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
