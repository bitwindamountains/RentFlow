import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createRental, lastEmail, PASSWORD, prismaOf, registerOwner, startApp, tokenIn, unique } from './helpers.js';

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x20), Buffer.from('\n%%EOF')]);
type Rental = Awaited<ReturnType<typeof createRental>>;

describe('documents shared with tenants', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let rentalA: Rental;
  let rentalB: Rental;
  let tenantA: Client;
  let tenantB: Client;

  const upload = (entityType: string, entityId: string, name = `Doc ${unique()}`) =>
    owner.request('POST', `/documents/files?name=${encodeURIComponent(name)}&category=Lease&entityType=${entityType}&entityId=${entityId}`, pdf, {
      'content-type': 'application/pdf',
    });
  const share = (client: Client, id: string, shared = true) => client.patch(`/documents/${id}/sharing`, { shared });

  async function portalClient(rental: Rental): Promise<Client> {
    await owner.post(`/tenants/${rental.tenant.id}/portal/invite`, {});
    const token = tokenIn(lastEmail(app, rental.tenant.email)?.text);
    await new Client(app).post('/staff/invitations/accept', { token, name: 'Tenant', password: PASSWORD });
    const client = new Client(app);
    await client.post('/auth/login', { email: rental.tenant.email, password: PASSWORD });
    return client;
  }

  beforeAll(async () => {
    app = await startApp();
    owner = (await registerOwner(app)).client;
    rentalA = await createRental(owner);
    rentalB = await createRental(owner);
    tenantA = await portalClient(rentalA);
    tenantB = await portalClient(rentalB);
  });
  afterAll(async () => app.close());

  it('shows a tenant only the documents shared with them, and serves the file safely', async () => {
    const tenantDoc = (await upload('Tenant', rentalA.tenant.id, 'House rules')).body;
    const leaseDoc = (await upload('Lease', rentalA.lease.id, 'Signed lease')).body;
    const privateDoc = (await upload('Tenant', rentalA.tenant.id, 'Background check')).body;
    const otherTenantDoc = (await upload('Tenant', rentalB.tenant.id, 'Other lease')).body;
    expect((await tenantA.get('/portal/documents')).body).toEqual([]);

    for (const doc of [tenantDoc, leaseDoc, otherTenantDoc]) expect((await share(owner, doc.id)).body.sharedWithTenant).toBe(true);

    const listed = (await tenantA.get('/portal/documents')).body;
    expect(listed.map((d: { name: string }) => d.name).sort()).toEqual(['House rules', 'Signed lease']);
    expect(Object.keys(listed[0]).sort()).toEqual(['category', 'contentType', 'createdAt', 'id', 'kind', 'name', 'sizeBytes', 'url']);

    const file = await tenantA.get(`/portal/documents/${leaseDoc.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(/^attachment;/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.raw.equals(pdf)).toBe(true);

    // Not shared, or shared with someone else: indistinguishable from missing.
    expect((await tenantA.get(`/portal/documents/${privateDoc.id}/file`)).status).toBe(404);
    expect((await tenantA.get(`/portal/documents/${otherTenantDoc.id}/file`)).status).toBe(404);
    expect((await tenantB.get('/portal/documents')).body.map((d: { name: string }) => d.name)).toEqual(['Other lease']);

    // Unsharing takes effect immediately.
    await share(owner, leaseDoc.id, false);
    expect((await tenantA.get(`/portal/documents/${leaseDoc.id}/file`)).status).toBe(404);

    // Staff see lease documents on the tenant page, with the sharing state.
    const detail = (await owner.get(`/tenants/${rentalA.tenant.id}`)).body;
    expect(detail.documents.find((d: { id: string }) => d.id === tenantDoc.id)).toMatchObject({ sharedWithTenant: true, entityType: 'Tenant' });
    expect(detail.documents.find((d: { id: string }) => d.id === leaseDoc.id)).toMatchObject({ sharedWithTenant: false, entityType: 'Lease' });
  });

  it('only shares tenant and lease documents, and only owners and managers can share', async () => {
    const propertyDoc = (await upload('Property', rentalA.property.id)).body;
    const shared = await share(owner, propertyDoc.id);
    expect(shared.status).toBe(422);
    expect(shared.body.code).toBe('DOCUMENT_NOT_SHAREABLE');
    // The database refuses it too.
    await expect(prismaOf(app).documentRecord.update({ where: { id: propertyDoc.id }, data: { sharedWithTenant: true } })).rejects.toThrow();

    const doc = (await upload('Tenant', rentalA.tenant.id)).body;
    expect((await share(tenantA, doc.id)).status).toBe(403);
    const email = `collector-${unique()}@rentflow.test`;
    const invite = await owner.post('/staff/invitations', { email, role: 'COLLECTOR' });
    await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: 'Collector', password: PASSWORD });
    const collector = new Client(app);
    await collector.post('/auth/login', { email, password: PASSWORD });
    expect((await share(collector, doc.id)).status).toBe(403);
    expect((await collector.get(`/portal/documents`)).status).toBe(403);

    const intruder = (await registerOwner(app)).client;
    expect((await share(intruder, doc.id)).status).toBe(404);
  });
});
