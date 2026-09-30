import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  createRental,
  lastEmail,
  monthStart,
  PASSWORD,
  prismaOf,
  registerOwner,
  startApp,
  today,
  tokenIn,
  unique,
} from './helpers.js';

describe('landlord operations', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let ownerEmail: string;

  beforeAll(async () => {
    app = await startApp();
    ({ client: owner, email: ownerEmail } = await registerOwner(app));
  });
  afterAll(async () => app.close());

  it('creates a whole rental atomically and replays the same request key', async () => {
    const label = unique();
    const body = {
      property: { name: `Setup ${label}`, type: 'Boarding house', address: '12 Rizal Avenue', city: 'Davao City' },
      unit: { number: 'R1', type: 'Room', monthlyRent: '4500.00' },
      tenant: { firstName: 'Ana', lastName: `Reyes ${label}`, email: '', phone: '' },
      lease: { startDate: monthStart(0), monthlyRent: '4500.00', billingDay: 1, dueDay: 5, depositRequired: '4500.00' },
      charge: { description: 'First month rent', dueDate: monthStart(0), billingPeriod: monthStart(0).slice(0, 7) },
    };
    const key = randomUUID();
    const first = await owner.post('/rental-setup', body, { 'idempotency-key': key });
    const replay = await owner.post('/rental-setup', body, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const tenant = (await owner.get(`/tenants/${first.body.tenantId}`)).body;
    expect(tenant.email).toBeNull();
    expect(tenant.leases[0].deposit).toEqual({ required: '4500.00', held: '0.00' });
    expect(tenant.openCharges).toHaveLength(1);

    // Invalid setup leaves no partial records.
    const before = await prismaOf(app).tenant.count();
    const invalid = await owner.post('/rental-setup', { ...body, property: { ...body.property, name: `Bad ${label}` }, charge: { ...body.charge, billingPeriod: '2000-01' } });
    expect(invalid.status).toBe(400);
    expect(await prismaOf(app).tenant.count()).toBe(before);
    // Missing idempotency key is rejected.
    expect((await owner.request('POST', '/rental-setup', body, { 'idempotency-key': '' })).status).toBe(400);
  });

  it('keeps security deposits separate from rent and prevents over-refunds', async () => {
    const rental = await createRental(owner, { depositRequired: '10000.00' });
    expect((await owner.post(`/leases/${rental.lease.id}/deposits`, { type: 'RECEIPT', amount: '10000.00' })).status).toBe(201);
    expect((await owner.post(`/leases/${rental.lease.id}/deposits`, { type: 'REFUND', amount: '10000.01', reason: 'Too much' })).body.code).toBe(
      'INVALID_DEPOSIT',
    );
    expect((await owner.post(`/leases/${rental.lease.id}/deposits`, { type: 'DEDUCTION', amount: '100.00' })).status).toBe(422);
    expect((await owner.post(`/leases/${rental.lease.id}/deposits`, { type: 'DEDUCTION', amount: '1500.00', reason: 'Broken window' })).status).toBe(201);
    const deposit = (await owner.get('/deposits')).body.find((d: { leaseId: string }) => d.leaseId === rental.lease.id);
    expect(deposit).toMatchObject({ requiredAmount: '10000.00', balance: '8500.00' });
    // Deposits never count as rent collected.
    const report = (await owner.get(`/reports/financial?from=${today()}&to=${today()}`)).body;
    expect(Number(report.collected)).toBe(0);
  });

  it('voids expenses entered in error and excludes them from reports', async () => {
    const rental = await createRental(owner);
    const expense = await owner.post('/expenses', {
      propertyId: rental.property.id,
      category: 'REPAIR',
      description: 'Replace lock',
      vendor: 'Local Locksmith',
      amount: '850.00',
      incurredOn: today(),
    });
    const mistake = await owner.post('/expenses', { category: 'OTHER', description: 'Typo', amount: '99999.00', incurredOn: today() });
    expect((await owner.post(`/expenses/${mistake.body.id}/void`, { reason: 'Entered by mistake' })).status).toBe(200);
    const list = (await owner.get('/expenses')).body.items;
    expect(list.map((e: { id: string }) => e.id)).toContain(expense.body.id);
    expect(list.map((e: { id: string }) => e.id)).not.toContain(mistake.body.id);
    const report = (await owner.get(`/reports/financial?from=${today()}&to=${today()}`)).body;
    expect(report.properties.find((p: { propertyId: string }) => p.propertyId === rental.property.id)).toMatchObject({ expenses: '850.00' });
    const csv = await owner.get(`/reports/transactions.csv?from=${today()}&to=${today()}`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Replace lock');
    expect(csv.text).toContain('VOIDED');
  });

  it('runs maintenance through a valid status workflow', async () => {
    const rental = await createRental(owner);
    const created = await owner.post('/maintenance', {
      propertyId: rental.property.id,
      unitId: rental.unit.id,
      title: 'Leaking tap',
      description: 'Kitchen tap needs a washer',
      priority: 'URGENT',
      dueOn: today(),
    });
    expect(created.body).toMatchObject({ status: 'OPEN', unitNumber: rental.unit.number });
    expect((await owner.get('/reminders')).body.some((r: { id: string }) => r.id === created.body.id)).toBe(true);
    const done = await owner.patch(`/maintenance/${created.body.id}`, { status: 'COMPLETED' });
    expect(done.body.completedAt).toBeTruthy();
    expect((await owner.patch(`/maintenance/${created.body.id}`, { status: 'IN_PROGRESS' })).body.code).toBe('INVALID_TRANSITION');
    const reopened = await owner.patch(`/maintenance/${created.body.id}`, { status: 'OPEN' });
    expect(reopened.body.completedAt).toBeNull();
    // Unit must belong to the property.
    const other = await createRental(owner);
    expect((await owner.post('/maintenance', { propertyId: rental.property.id, unitId: other.unit.id, title: 'Wrong unit', description: 'Wrong unit', priority: 'LOW' })).status).toBe(404);
  });

  it('links documents only to records in the same organization and soft-deletes them', async () => {
    const rental = await createRental(owner);
    expect(
      (await owner.post('/documents', { name: 'ID', category: 'Identity', entityType: 'Tenant', entityId: randomUUID(), url: 'https://files.example.com/id.pdf' })).status,
    ).toBe(404);
    expect((await owner.post('/documents', { name: 'ID', category: 'Identity', url: 'http://insecure.example.com/id.pdf' })).status).toBe(400);
    expect((await owner.post('/documents', { name: 'ID', category: 'Identity', url: 'javascript:alert(1)' })).status).toBe(400);
    const doc = await owner.post('/documents', {
      name: 'Signed lease',
      category: 'Lease',
      entityType: 'Tenant',
      entityId: rental.tenant.id,
      url: 'https://files.example.com/lease.pdf',
    });
    expect((await owner.get(`/tenants/${rental.tenant.id}`)).body.documents).toHaveLength(1);
    expect((await owner.delete(`/documents/${doc.body.id}`)).status).toBe(200);
    expect((await owner.get('/documents')).body.some((d: { id: string }) => d.id === doc.body.id)).toBe(false);
    expect(await prismaOf(app).documentRecord.count({ where: { id: doc.body.id } })).toBe(1);
  });

  it('edits units, archives former tenants, and refuses to archive tenants who owe', async () => {
    const rental = await createRental(owner);
    expect((await owner.patch(`/units/${rental.unit.id}`, { number: rental.unit.number, type: 'One bedroom', monthlyRent: '11000.00' })).status).toBe(200);
    expect((await owner.post(`/tenants/${rental.tenant.id}/archive`)).body.code).toBe('TENANT_HAS_BALANCE');
    const [charge] = (await owner.get(`/leases/${rental.lease.id}/open-charges`)).body;
    await owner.post(`/charges/${charge.id}/adjustments`, { type: 'WAIVER', amount: charge.outstanding, reason: 'Goodwill' });
    expect((await owner.post(`/tenants/${rental.tenant.id}/archive`)).body.code).toBe('TENANT_HAS_ACTIVE_LEASE');
    await owner.post(`/leases/${rental.lease.id}/terminate`, { endDate: today(), reason: 'Moved out' });
    expect((await owner.post(`/tenants/${rental.tenant.id}/archive`)).status).toBe(201);
    expect((await owner.get('/tenants')).body.some((t: { id: string }) => t.id === rental.tenant.id)).toBe(false);
    expect((await owner.get('/tenants?includeArchived=true')).body.some((t: { id: string }) => t.id === rental.tenant.id)).toBe(true);
  });

  it('emails invitations, lets existing users join with their password, and switches workspaces', async () => {
    const { client: other, email: otherEmail } = await registerOwner(app);
    const invite = await owner.post('/staff/invitations', { email: otherEmail, role: 'MANAGER' });
    expect(invite.body.link).toContain('/accept-invite#token=');
    expect(tokenIn(lastEmail(app, otherEmail)?.text)).toBe(invite.body.token);
    expect((await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, password: 'not my password!' })).status).toBe(401);
    const accepted = await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, password: PASSWORD });
    expect(accepted.body.accepted).toBe(true);
    expect((await owner.post('/staff/invitations', { email: otherEmail, role: 'VIEWER' })).body.code).toBe('ALREADY_A_MEMBER');

    const me = (await other.get('/auth/me')).body;
    expect(me.workspaces).toHaveLength(2);
    const switched = await other.post('/auth/switch-workspace', { workspace: accepted.body.workspace });
    expect(switched.body).toMatchObject({ role: 'MANAGER' });
    expect((await other.get('/staff')).status).toBe(403);
    expect(ownerEmail).toBeTruthy();
  });

  it('shows who did what in the audit log', async () => {
    const log = (await owner.get('/audit-log?limit=20')).body;
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]).toMatchObject({ action: expect.any(String), actor: expect.any(String) });
  });
});
