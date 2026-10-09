import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createRental, PASSWORD, prismaOf, registerOwner, startApp, tokenIn } from './helpers.js';

describe('record history pagination', () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  let rental: Awaited<ReturnType<typeof createRental>>;
  let otherRental: Awaited<ReturnType<typeof createRental>>;
  let tenant: Client;
  const date = new Date('2025-01-01T00:00:00.000Z');

  async function collect(client: Client, path: string, limit = 100) {
    let cursor = '';
    const ids: string[] = [];
    for (let page = 0; page < 20; page++) {
      const result = await client.get(`${path}${path.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(result.status).toBe(200);
      expect(result.body.length).toBeLessThanOrEqual(limit);
      ids.push(...result.body.map((row: { id: string }) => row.id));
      cursor = String(result.headers['x-next-cursor'] ?? '');
      if (!cursor) { expect(new Set(ids).size).toBe(ids.length); return ids; }
    }
    throw new Error('Pagination did not terminate');
  }

  beforeAll(async () => {
    app = await startApp();
    owner = await registerOwner(app);
    rental = await createRental(owner.client);
    otherRental = await createRental(owner.client);
    const invite = await owner.client.post(`/tenants/${rental.tenant.id}/portal/invite`, {});
    await new Client(app).post('/staff/invitations/accept', { token: tokenIn(invite.body.link), name: 'Tenant', password: PASSWORD });
    tenant = new Client(app);
    expect((await tenant.post('/auth/login', { email: rental.tenant.email, password: PASSWORD })).status).toBe(200);
  });
  afterAll(async () => app.close());

  it('reaches documents beyond the old caps without crossing tenant boundaries, including timestamp ties', async () => {
    const db = prismaOf(app);
    const organizationId = owner.profile.organization.id;
    await db.documentRecord.createMany({ data: Array.from({ length: 513 }, (_, i) => ({
      organizationId, createdBy: owner.profile.user.id, name: `Document ${i}`, category: 'Lease',
      entityType: 'Tenant', entityId: i < 205 ? rental.tenant.id : otherRental.tenant.id,
      sharedWithTenant: true, url: 'https://example.com/private-file', createdAt: date,
    })) });
    expect(await collect(owner.client, '/documents', 200)).toHaveLength(513);
    const own = await db.documentRecord.findMany({ where: { organizationId, entityId: rental.tenant.id }, select: { id: true } });
    expect((await collect(tenant, '/portal/documents', 80)).sort()).toEqual(own.map(row => row.id).sort());
    const first = await tenant.get('/portal/documents?limit=1');
    await owner.client.delete(`/documents/${first.body[0].id}`);
    const rest = await tenant.get(`/portal/documents?limit=200&cursor=${first.headers['x-next-cursor']}`);
    expect(rest.status).toBe(200);
    expect(rest.body).toHaveLength(200);
    expect(rest.body.map((row: { id: string }) => row.id)).not.toContain(first.body[0].id);
    expect((await tenant.get('/portal/documents?cursor=invalid')).status).toBe(400);
    expect((await owner.client.get('/documents?limit=201')).status).toBe(400);
    expect((await tenant.get('/portal/documents', { origin: 'http://localhost:4200' })).headers['access-control-expose-headers']).toContain('x-next-cursor');
  });

  it('pages work orders while retaining priority order and portal ownership', async () => {
    const db = prismaOf(app);
    const organizationId = owner.profile.organization.id;
    await db.maintenanceRequest.createMany({ data: Array.from({ length: 503 }, (_, i) => ({
      organizationId, propertyId: rental.property.id, unitId: rental.unit.id,
      tenantId: i < 103 ? rental.tenant.id : otherRental.tenant.id,
      title: `Repair ${i}`, description: 'A repair request', createdAt: date,
      priority: i % 2 ? 'LOW' as const : 'URGENT' as const,
    })) });
    const first = await owner.client.get('/maintenance?status=active&limit=5');
    expect(first.body.every((row: { priority: string }) => row.priority === 'URGENT')).toBe(true);
    expect(await collect(owner.client, '/maintenance?status=active', 200)).toHaveLength(503);
    const own = await db.maintenanceRequest.findMany({ where: { organizationId, tenantId: rental.tenant.id }, select: { id: true } });
    expect((await collect(tenant, '/portal/maintenance', 30)).sort()).toEqual(own.map(row => row.id).sort());
  });

  it('pages payment history and reports independently beyond 100 records', async () => {
    const db = prismaOf(app);
    const organizationId = owner.profile.organization.id;
    await db.payment.createMany({ data: Array.from({ length: 105 }, () => ({
      organizationId, tenantId: rental.tenant.id, leaseId: rental.lease.id,
      amount: '1.00', method: 'CASH' as const, paidAt: date, status: 'POSTED' as const,
      postedAt: date, recordedBy: owner.profile.user.id,
    })) });
    await db.paymentNotice.createMany({ data: Array.from({ length: 205 }, (_, i) => ({
      organizationId, tenantId: i < 104 ? rental.tenant.id : otherRental.tenant.id,
      leaseId: i < 104 ? rental.lease.id : otherRental.lease.id,
      amount: '1.00', method: 'CASH' as const, paidOn: date, createdAt: date, submittedBy: owner.profile.user.id,
    })) });
    for (const kind of ['payments', 'notices'] as const) {
      let cursor = '';
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const result = await tenant.get(`/portal/payments?limit=30${cursor ? `&${kind}Cursor=${cursor}` : ''}`);
        expect(result.status).toBe(200);
        ids.push(...result.body[kind].map((row: { id: string }) => row.id));
        cursor = result.body[`${kind}NextCursor`] ?? '';
        if (!cursor) break;
      }
      expect(cursor).toBe('');
      expect(new Set(ids).size).toBe(kind === 'payments' ? 105 : 104);
      expect(ids.length).toBe(new Set(ids).size);
    }
    expect(await collect(owner.client, '/payment-notices', 80)).toHaveLength(205);
  });
});
