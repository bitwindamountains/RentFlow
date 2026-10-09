import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createRental, PASSWORD, prismaOf, registerOwner, startApp, today, tokenIn, unique } from './helpers.js';

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF')]);

describe('tenant data export and erasure', () => {
  let app: NestFastifyApplication;
  let owner: Client;

  beforeAll(async () => {
    app = await startApp();
    owner = (await registerOwner(app)).client;
  });
  afterAll(async () => app.close());

  /** A former tenant with distinctive personal details, a portal login, a repair report and an ID document. */
  async function formerTenant() {
    const rental = await createRental(owner, { firstMonth: 'NONE' });
    const marker = `Zq${unique().replace(/\W/g, '')}`;
    const person = { firstName: 'Liza', lastName: marker, email: `${marker.toLowerCase()}@example.test`, phone: `+63 917 ${String(Date.now()).slice(-7)}` };
    expect((await owner.patch(`/tenants/${rental.tenant.id}`, person)).status).toBe(200);

    const invite = await owner.post(`/tenants/${rental.tenant.id}/portal/invite`, {});
    const accepted = await new Client(app).post('/staff/invitations/accept', { token: tokenIn(invite.body.link), name: `Liza ${marker}`, password: PASSWORD });
    expect(accepted.body).toMatchObject({ accepted: true, role: 'TENANT' });
    const portal = new Client(app);
    expect((await portal.post('/auth/login', { email: person.email, password: PASSWORD })).status).toBe(200);
    expect((await portal.post('/portal/maintenance', { title: 'Leaking faucet', description: `Please call ${person.phone}, ${person.firstName} ${marker}`, priority: 'MEDIUM' })).status).toBe(201);

    const document = await owner.request('POST', `/documents/files?name=ID%20of%20${marker}&category=ID&entityType=Tenant&entityId=${rental.tenant.id}`, pdf, { 'content-type': 'application/pdf' });
    expect(document.status).toBe(201);
    return { rental, person, marker, portal, documentId: document.body.id as string };
  }

  /** Every row in the schema whose text contains the value, to prove nothing personal is left. */
  async function rowsContaining(value: string) {
    const prisma = prismaOf(app);
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    const hits: string[] = [];
    for (const { table_name } of tables) {
      const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM "${table_name}" t WHERE t::text ILIKE $1`, `%${value}%`);
      if (row && row.count > 0n) hits.push(table_name);
    }
    return hits;
  }

  it('exports everything held about a tenant, to owners and managers of that workspace only', async () => {
    const { rental, person, documentId } = await formerTenant();
    const exported = await owner.get(`/tenants/${rental.tenant.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body.tenant).toMatchObject({ id: rental.tenant.id, email: person.email, phone: person.phone });
    expect(exported.body.leases.map((lease: { id: string }) => lease.id)).toEqual([rental.lease.id]);
    expect(exported.body.maintenance).toHaveLength(1);
    expect(exported.body.documents).toEqual([expect.objectContaining({ id: documentId, download: `/api/v1/documents/${documentId}/file` })]);
    expect(exported.body.documents[0].storageKey).toBeUndefined();

    const outsider = (await registerOwner(app)).client;
    expect((await outsider.get(`/tenants/${rental.tenant.id}/export`)).status).toBe(404);
  });

  it('refuses while the tenant still has an open lease, and needs the owner’s password', async () => {
    const { rental } = await formerTenant();
    expect((await owner.post(`/tenants/${rental.tenant.id}/erase`, { password: PASSWORD })).body.code).toBe('TENANT_ERASE_ACTIVE_LEASE');
    expect((await owner.post(`/tenants/${rental.tenant.id}/erase`, { password: 'not the password at all' })).body.code).toBe('PASSWORD_INCORRECT');
    const outsider = (await registerOwner(app)).client;
    expect((await outsider.post(`/tenants/${rental.tenant.id}/erase`, { password: PASSWORD })).status).toBe(404);
    // Only owners erase; managers may export.
    const email = `manager-${unique()}@rentflow.test`;
    const invite = await owner.post('/staff/invitations', { email, role: 'MANAGER' });
    await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: 'Manager', password: PASSWORD });
    const manager = new Client(app);
    await manager.post('/auth/login', { email, password: PASSWORD });
    expect((await manager.get(`/tenants/${rental.tenant.id}/export`)).status).toBe(200);
    expect((await manager.post(`/tenants/${rental.tenant.id}/erase`, { password: PASSWORD })).status).toBe(403);
  });

  it('erases personal details everywhere but keeps the financial records', async () => {
    const { rental, person, marker, portal, documentId } = await formerTenant();
    expect((await owner.post(`/leases/${rental.lease.id}/terminate`, { endDate: today(), reason: 'Moved out' })).status).toBe(201);
    expect(await rowsContaining(marker)).not.toEqual([]);

    const erased = await owner.post(`/tenants/${rental.tenant.id}/erase`, { password: PASSWORD });
    expect(erased.status).toBe(201);
    expect(erased.body).toEqual({ erased: true });

    for (const value of [marker, person.email, person.phone]) expect(await rowsContaining(value), value).toEqual([]);
    const tenant = (await owner.get(`/tenants/${rental.tenant.id}`)).body;
    expect(tenant).toMatchObject({ firstName: 'Erased', email: null, phone: null });
    // The lease and its history stay; the portal login is gone.
    expect((await owner.get(`/leases/${rental.lease.id}/open-charges`)).status).toBe(200);
    expect((await portal.get('/auth/me')).status).toBe(401);
    expect((await new Client(app).post('/auth/login', { email: person.email, password: PASSWORD })).status).toBe(401);
    expect((await owner.get(`/documents/${documentId}/file`)).status).toBe(404);
    // Repeating the request is harmless.
    expect((await owner.post(`/tenants/${rental.tenant.id}/erase`, { password: PASSWORD })).body).toEqual({ erased: true });
  });
});
