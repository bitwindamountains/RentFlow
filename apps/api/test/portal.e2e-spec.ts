import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  createRental,
  daysFromToday,
  lastEmail,
  PASSWORD,
  prismaOf,
  registerOwner,
  startApp,
  today,
  tokenIn,
  unique,
} from './helpers.js';

type Rental = Awaited<ReturnType<typeof createRental>>;

describe('tenant portal', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let rentalA: Rental;
  let rentalB: Rental;
  let tenantA: Client;
  let tenantB: Client;

  /** Invites a rental's tenant to the portal, accepts by email link, and signs in. */
  async function portalClient(rental: Rental, staff = owner): Promise<Client> {
    const invite = await staff.post(`/tenants/${rental.tenant.id}/portal/invite`, {});
    expect(invite.status).toBe(201);
    const email = rental.tenant.email as string;
    const token = tokenIn(lastEmail(app, email)?.text);
    expect(token).toBe(tokenIn(invite.body.link));
    const accepted = await new Client(app).post('/staff/invitations/accept', { token, name: rental.tenant.firstName + ' Tenant', password: PASSWORD });
    expect(accepted.body).toMatchObject({ accepted: true, role: 'TENANT' });
    const client = new Client(app);
    const login = await client.post('/auth/login', { email, password: PASSWORD });
    expect(login.body.role).toBe('TENANT');
    return client;
  }

  const notice = (client: Client, leaseId: string, overrides: Record<string, unknown> = {}, key = randomUUID()) =>
    client.post('/portal/payment-notices', { leaseId, amount: '4000.00', method: 'GCASH', referenceNumber: `GC${unique()}`, paidOn: today(), ...overrides }, { 'idempotency-key': key });

  beforeAll(async () => {
    app = await startApp();
    owner = (await registerOwner(app)).client;
    rentalA = await createRental(owner, { rent: '10000.00' });
    rentalB = await createRental(owner, { rent: '8000.00' });
    tenantA = await portalClient(rentalA);
    tenantB = await portalClient(rentalB);
  });
  afterAll(async () => app.close());

  it('shows a tenant only their own balance, charges, and lease', async () => {
    const home = await tenantA.get('/portal/home');
    expect(home.status).toBe(200);
    expect(home.body.tenant.lastName).toBe(rentalA.tenant.lastName);
    expect(home.body.balance.outstanding).toBe('10000.00');
    expect(home.body.openCharges).toHaveLength(1);
    expect(home.body.openCharges.every((c: { leaseId: string }) => c.leaseId === rentalA.lease.id)).toBe(true);
    expect(home.body.leases.map((l: { id: string }) => l.id)).toEqual([rentalA.lease.id]);
    expect(JSON.stringify(home.body)).not.toContain(rentalB.tenant.lastName);
    expect((await tenantA.get('/auth/me')).body).toMatchObject({ role: 'TENANT' });
  });

  it('denies tenants every staff endpoint', async () => {
    const reads = ['/tenants', `/tenants/${rentalA.tenant.id}`, '/payments', '/charges', '/dashboard', '/reminders', '/arrears', '/leases', '/properties', '/documents', '/maintenance', '/expenses', '/staff', '/payment-notices', '/audit-log', '/collections/options', `/tenants/${rentalA.tenant.id}/portal`];
    for (const path of reads) expect([path, (await tenantA.get(path)).status]).toEqual([path, 403]);
    const writes: Array<[string, unknown]> = [
      ['/payments', { tenantId: rentalA.tenant.id, leaseId: rentalA.lease.id, amount: '1.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] }],
      ['/tenants', { firstName: 'X', lastName: 'Y' }],
      [`/tenants/${rentalA.tenant.id}/portal/invite`, {}],
      ['/staff/invitations', { email: `x-${unique()}@t.test`, role: 'MANAGER' }],
    ];
    for (const [path, body] of writes) expect([path, (await tenantA.post(path, body)).status]).toEqual([path, 403]);
    // And staff cannot use the tenant routes.
    expect((await owner.get('/portal/home')).status).toBe(403);
  });

  it('keeps tenants of the same landlord apart', async () => {
    // B's notice and payment are invisible and untouchable for A.
    const mine = await notice(tenantB, rentalB.lease.id);
    expect(mine.status).toBe(201);
    expect((await notice(tenantA, rentalB.lease.id)).status).toBe(404);
    expect((await tenantA.post(`/portal/payment-notices/${mine.body.id}/withdraw`)).status).toBe(404);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect((await tenantA.request('POST', `/portal/payment-notices/${mine.body.id}/proof`, png, { 'content-type': 'image/png' })).status).toBe(404);
    const confirmed = await owner.post(`/payment-notices/${mine.body.id}/confirm`, {});
    expect((await tenantA.get(`/portal/payments/${confirmed.body.notice.paymentId}/receipt`)).status).toBe(404);
    expect((await tenantB.get(`/portal/payments/${confirmed.body.notice.paymentId}/receipt`)).status).toBe(200);
    const history = (await tenantA.get('/portal/payments')).body;
    expect(history.notices.map((n: { id: string }) => n.id)).not.toContain(mine.body.id);
    expect(history.payments.map((p: { id: string }) => p.id)).not.toContain(confirmed.body.notice.paymentId);
  });

  it('turns a confirmed payment report into a real payment and receipt, exactly once', async () => {
    const key = randomUUID();
    const first = await notice(tenantA, rentalA.lease.id, { amount: '4000.00', referenceNumber: 'GC-778899' }, key);
    const replay = await notice(tenantA, rentalA.lease.id, { amount: '4000.00', referenceNumber: 'GC-778899' }, key);
    expect(first.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(first.body.status).toBe('SUBMITTED');

    // Nothing is posted until staff confirm.
    expect((await tenantA.get('/portal/home')).body.balance.outstanding).toBe('10000.00');
    const queue = (await owner.get('/payment-notices')).body;
    const queued = queue.find((n: { id: string }) => n.id === first.body.id);
    expect(queued).toMatchObject({ tenantName: expect.stringContaining(rentalA.tenant.lastName), leaseOutstanding: '10000.00' });
    expect((await owner.get('/reminders')).body.some((r: { type: string; id: string }) => r.type === 'PAYMENT_NOTICE' && r.id === first.body.id)).toBe(true);

    const confirmed = await owner.post(`/payment-notices/${first.body.id}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.notice).toMatchObject({ status: 'CONFIRMED', receiptNumber: confirmed.body.payment.receiptNumber });
    expect(confirmed.body.payment).toMatchObject({ amount: '4000.00', method: 'GCASH', referenceNumber: 'GC-778899' });
    expect(confirmed.body.payment.allocations).toHaveLength(1);
    const again = await owner.post(`/payment-notices/${first.body.id}/confirm`, {});
    expect(again.body).toMatchObject({ alreadyConfirmed: true, notice: { paymentId: confirmed.body.notice.paymentId } });
    expect(await prismaOf(app).payment.count({ where: { tenantId: rentalA.tenant.id } })).toBe(1);

    const home = (await tenantA.get('/portal/home')).body;
    expect(home.balance.outstanding).toBe('6000.00');
    expect(home.recentPayments[0]).toMatchObject({ amount: '4000.00', receiptNumber: confirmed.body.payment.receiptNumber });
    const receipt = await tenantA.get(`/portal/payments/${confirmed.body.notice.paymentId}/receipt`);
    expect(receipt.body).toMatchObject({ amount: '4000.00', tenantName: expect.stringContaining(rentalA.tenant.lastName) });
    expect(lastEmail(app, rentalA.tenant.email)?.subject).toContain(confirmed.body.payment.receiptNumber);
    // A reviewed report cannot be withdrawn or reviewed again.
    expect((await tenantA.post(`/portal/payment-notices/${first.body.id}/withdraw`)).status).toBe(404);
    expect((await owner.post(`/payment-notices/${first.body.id}/reject`, { reason: 'Changed mind' })).status).toBe(409);
  });

  it('lets staff reject a report with a reason, and tenants withdraw their own', async () => {
    const rejected = await notice(tenantA, rentalA.lease.id, { amount: '500.00' });
    const result = await owner.post(`/payment-notices/${rejected.body.id}/reject`, { reason: 'No matching GCash transfer' });
    expect(result.body.notice).toMatchObject({ status: 'REJECTED', rejectionReason: 'No matching GCash transfer' });
    expect(lastEmail(app, rentalA.tenant.email)?.text).toContain('No matching GCash transfer');
    expect((await owner.post(`/payment-notices/${rejected.body.id}/confirm`, {})).status).toBe(409);

    const withdrawn = await notice(tenantA, rentalA.lease.id, { amount: '700.00' });
    expect((await tenantA.post(`/portal/payment-notices/${withdrawn.body.id}/withdraw`)).body).toEqual({ withdrawn: true });
    expect((await owner.post(`/payment-notices/${withdrawn.body.id}/confirm`, {})).status).toBe(409);
  });

  it('validates payment reports', async () => {
    expect((await notice(tenantA, rentalA.lease.id, { paidOn: daysFromToday(1) })).body.code).toBe('FUTURE_PAYMENT_DATE');
    expect((await notice(tenantA, rentalA.lease.id, { paidOn: daysFromToday(-91) })).body.code).toBe('PAYMENT_DATE_TOO_OLD');
    expect((await notice(tenantA, rentalA.lease.id, { amount: '0.00' })).status).toBe(400);
    expect((await notice(tenantA, rentalA.lease.id, { method: 'CARD' })).status).toBe(400);
    expect((await tenantA.post('/portal/payment-notices', { leaseId: rentalA.lease.id, amount: '1.00', method: 'GCASH', paidOn: today() })).body.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('accepts a proof screenshot that only staff can open', async () => {
    const report = await notice(tenantA, rentalA.lease.id, { amount: '1200.00' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    const proof = await tenantA.request('POST', `/portal/payment-notices/${report.body.id}/proof`, png, { 'content-type': 'image/png' });
    expect(proof.status).toBe(201);
    expect((await tenantA.request('POST', `/portal/payment-notices/${report.body.id}/proof`, Buffer.from('<svg/>'), { 'content-type': 'image/png' })).status).toBe(415);
    const queued = (await owner.get('/payment-notices')).body.find((n: { id: string }) => n.id === report.body.id);
    expect(queued.proofs).toEqual([{ id: proof.body.id, contentType: 'image/png' }]);
    expect((await owner.get(`/documents/${proof.body.id}/file`)).raw.equals(png)).toBe(true);
    expect((await tenantA.get(`/documents/${proof.body.id}/file`)).status).toBe(403);
  });

  it('records repair requests against the tenant’s own unit', async () => {
    const created = await tenantA.post('/portal/maintenance', { title: 'Leaking faucet', description: 'Kitchen faucet drips all night.', priority: 'MEDIUM' });
    expect(created.status).toBe(201);
    const row = await prismaOf(app).maintenanceRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row).toMatchObject({ unitId: rentalA.unit.id, propertyId: rentalA.property.id, tenantId: rentalA.tenant.id });
    // A lease id from someone else is ignored as "not yours".
    expect((await tenantA.post('/portal/maintenance', { leaseId: rentalB.lease.id, title: 'Other', description: 'Not my unit at all', priority: 'LOW' })).body.code).toBe('CHOOSE_LEASE');
    expect((await tenantA.get('/portal/maintenance')).body.map((m: { id: string }) => m.id)).toEqual([created.body.id]);
    expect((await tenantB.get('/portal/maintenance')).body).toEqual([]);
    const staffView = (await owner.get('/maintenance')).body.find((m: { id: string }) => m.id === created.body.id);
    expect(staffView.reportedByTenant).toBe(true);
  });

  it('never lets portal accounts be managed or promoted as staff', async () => {
    const staffList = (await owner.get('/staff')).body;
    expect(staffList.members.some((m: { role: string }) => m.role === 'TENANT')).toBe(false);
    const membership = await prismaOf(app).membership.findFirstOrThrow({ where: { tenantId: rentalA.tenant.id, status: 'ACTIVE' } });
    expect((await owner.patch(`/staff/${membership.id}`, { role: 'MANAGER' })).status).toBe(404);
    expect((await owner.patch(`/staff/${membership.id}`, { status: 'SUSPENDED' })).status).toBe(404);
    expect((await owner.post('/staff/invitations', { email: `t-${unique()}@t.test`, role: 'TENANT' })).status).toBe(400);
    // The database refuses a staff role bound to a tenant, or a tenant role without one.
    await expect(prismaOf(app).membership.update({ where: { id: membership.id }, data: { role: 'MANAGER' } })).rejects.toThrow();
    // Other workspaces cannot see or manage this portal.
    const outsider = (await registerOwner(app)).client;
    expect((await outsider.get(`/tenants/${rentalA.tenant.id}/portal`)).status).toBe(404);
    expect((await outsider.delete(`/tenants/${rentalA.tenant.id}/portal`)).status).toBe(404);
    const pending = await notice(tenantA, rentalA.lease.id, { amount: '50.00' });
    expect((await outsider.post(`/payment-notices/${pending.body.id}/confirm`, {})).status).toBe(404);
    // Roles below manager cannot grant portal access; collectors may confirm payments.
    const viewerEmail = `viewer-${unique()}@rentflow.test`;
    const viewerInvite = await owner.post('/staff/invitations', { email: viewerEmail, role: 'VIEWER' });
    await new Client(app).post('/staff/invitations/accept', { token: viewerInvite.body.token, name: 'Viewer person', password: PASSWORD });
    const viewer = new Client(app);
    await viewer.post('/auth/login', { email: viewerEmail, password: PASSWORD });
    expect((await viewer.post(`/tenants/${rentalA.tenant.id}/portal/invite`, {})).status).toBe(403);
    expect((await viewer.post(`/payment-notices/${pending.body.id}/confirm`, {})).status).toBe(403);
    expect((await viewer.get('/payment-notices')).status).toBe(200);
  });

  it('ends access immediately when revoked or when the tenant is archived', async () => {
    expect((await owner.get(`/tenants/${rentalB.tenant.id}/portal`)).body.status).toBe('ACTIVE');
    expect((await owner.post(`/tenants/${rentalB.tenant.id}/portal/invite`, {})).body.code).toBe('ALREADY_A_MEMBER');
    expect((await owner.delete(`/tenants/${rentalB.tenant.id}/portal`)).status).toBe(200);
    expect((await tenantB.get('/portal/home')).status).toBe(401);
    expect((await new Client(app).post('/auth/login', { email: rentalB.tenant.email, password: PASSWORD })).status).toBe(401);
    expect((await owner.get(`/tenants/${rentalB.tenant.id}/portal`)).body.status).toBe('NONE');

    // Re-invite works after revocation.
    const again = await portalClient(rentalB);
    expect((await again.get('/portal/home')).status).toBe(200);

    // Archiving the tenant cuts the portal off without touching the membership row.
    const rentalC = await createRental(owner);
    const tenantC = await portalClient(rentalC);
    await prismaOf(app).tenant.update({ where: { id: rentalC.tenant.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    expect((await tenantC.get('/portal/home')).status).toBe(401);
    expect((await owner.post(`/tenants/${rentalC.tenant.id}/portal/invite`, {})).body.code).toBe('TENANT_ARCHIVED');
  });

  it('requires an email to invite and rejects tenants who are already staff here', async () => {
    const tenant = await owner.post('/tenants', { firstName: 'No', lastName: `Email ${unique()}`, email: '', phone: '' });
    expect((await owner.post(`/tenants/${tenant.body.id}/portal/invite`, {})).body.code).toBe('PORTAL_EMAIL_REQUIRED');
    const ownerProfile = (await owner.get('/auth/me')).body;
    expect((await owner.post(`/tenants/${tenant.body.id}/portal/invite`, { email: ownerProfile.user.email })).body.code).toBe('ALREADY_A_MEMBER');
  });
});
