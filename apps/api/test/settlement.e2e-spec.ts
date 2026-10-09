import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { JobsService } from '../src/jobs/jobs.service.js';
import { createRental, daysFromToday, monthStart, prismaOf, registerOwner, startApp, today } from './helpers.js';

let app: NestFastifyApplication;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

it('catches up rent through expiry and allows staff to collect the ended lease', async () => {
  const { client } = await registerOwner(app);
  const endDate = daysFromToday(-1);
  const rental = await createRental(client, { startDate: monthStart(-2), endDate, rent: '10000.00' });
  await app.get(JobsService).runAll();
  const charges = await prismaOf(app).charge.findMany({ where: { leaseId: rental.lease.id } });
  // Move-in month plus every billing day up to the inclusive end date.
  const expected = endDate.slice(0, 7) === today().slice(0, 7) ? 3 : 2;
  expect(charges).toHaveLength(expected);
  const option = (await client.get('/collections/options')).body.find((item: any) => item.leaseId === rental.lease.id);
  expect(option).toMatchObject({ leaseStatus: 'EXPIRED', outstanding: (expected * 10000).toFixed(2) });
  const paid = await client.post('/payments', { leaseId: rental.lease.id, tenantId: rental.tenant.id, amount: option.outstanding,
    method: 'CASH', paidAt: new Date().toISOString(), allocations: [] });
  expect(paid.status).toBe(201);
  expect((await client.get(`/leases/${rental.lease.id}/open-charges`)).body).toEqual([]);
  expect((await client.get('/collections/options')).body.some((item: any) => item.leaseId === rental.lease.id)).toBe(false);
  await app.get(JobsService).runAll();
  expect(await prismaOf(app).charge.count({ where: { leaseId: rental.lease.id } })).toBe(expected);
});

it('recovers missed rent on an already terminated lease without billing beyond its end', async () => {
  const { client } = await registerOwner(app);
  const rental = await createRental(client, { startDate: monthStart(-3), rent: '1000.00' });
  expect((await client.post(`/leases/${rental.lease.id}/terminate`, { endDate: monthStart(-1), reason: 'Moved out' })).status).toBe(201);
  await client.post('/billing/run', {});
  const charges = await prismaOf(app).charge.findMany({ where: { leaseId: rental.lease.id }, orderBy: { billingPeriod: 'asc' } });
  expect(charges.map(c => c.billingPeriod)).toEqual([-3, -2, -1].map(offset => monthStart(offset).slice(0, 7)));
});

it('applies prepayments to new charges and restores both charges on reversal', async () => {
  const { client } = await registerOwner(app);
  const rental = await createRental(client, { rent: '10000.00' });
  const paid = await client.post('/payments', { leaseId: rental.lease.id, tenantId: rental.tenant.id, amount: '20000.00',
    method: 'CASH', paidAt: new Date().toISOString(), allocations: [] });
  expect(paid.status).toBe(201);
  expect(paid.body.unallocated).toBe('10000.00');
  expect((await client.post('/charges', { leaseId: rental.lease.id, type: 'OTHER', description: 'Later charge', amount: '10000.00', dueDate: daysFromToday(-1) })).status).toBe(201);
  const option = (await client.get('/collections/options')).body.find((item: any) => item.leaseId === rental.lease.id);
  expect(option).toMatchObject({ outstanding: '0.00', balance: '0.00' });
  expect((await client.get('/arrears')).body).toEqual([]);
  expect((await client.get(`/payments/${paid.body.id}/receipt`)).body.credit).toBe('0.00');
  expect(await prismaOf(app).auditLog.count({ where: { entityId: paid.body.id, action: 'PAYMENT_CREDIT_APPLIED' } })).toBe(2);
  expect((await client.post(`/payments/${paid.body.id}/reverse`, { reason: 'Bounced payment' })).status).toBe(201);
  const open = (await client.get(`/leases/${rental.lease.id}/open-charges`)).body;
  expect(open).toHaveLength(2);
  expect(open.map((charge: any) => charge.outstanding)).toEqual(['10000.00', '10000.00']);
});

it('does not allocate the same advance twice during concurrent charge creation', async () => {
  const { client } = await registerOwner(app);
  const rental = await createRental(client, { firstMonth: 'NONE' });
  const paid = await client.post('/payments', { leaseId: rental.lease.id, tenantId: rental.tenant.id, amount: '1000.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] });
  const results = await Promise.all(['Water', 'Power'].map(description => client.post('/charges', {
    leaseId: rental.lease.id, type: 'OTHER', description, amount: '1000.00', dueDate: today(),
  })));
  expect(results.map(r => r.status)).toEqual([201, 201]);
  const allocated = await prismaOf(app).paymentAllocation.aggregate({ where: { paymentId: paid.body.id }, _sum: { amount: true } });
  expect(allocated._sum.amount?.toFixed(2)).toBe('1000.00');
  const option = (await client.get('/collections/options')).body.find((item: any) => item.leaseId === rental.lease.id);
  expect(option.outstanding).toBe('1000.00');
});

it('replays a payment after the legacy key expiry and job cleanup', async () => {
  const { client, profile } = await registerOwner(app);
  const rental = await createRental(client, { firstMonth: 'NONE' });
  const key = randomUUID();
  const input = { tenantId: rental.tenant.id, leaseId: rental.lease.id, amount: '1000.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [] };
  const first = await client.post('/payments', input, { 'idempotency-key': key });
  expect(first.status).toBe(201);
  await prismaOf(app).idempotencyKey.updateMany({ where: { organizationId: profile.organization.id, key }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
  await app.get(JobsService).runAll();
  const retry = await client.post('/payments', input, { 'idempotency-key': key });
  expect(retry.status).toBe(201);
  expect(retry.body).toEqual(first.body);
  expect(await prismaOf(app).payment.count({ where: { leaseId: rental.lease.id } })).toBe(1);
});

it('replays simultaneous retries before revalidating already settled allocations', async () => {
  const { client } = await registerOwner(app);
  const rental = await createRental(client, { rent: '1000.00' });
  const [charge] = (await client.get(`/leases/${rental.lease.id}/open-charges`)).body;
  const key = randomUUID();
  const input = { tenantId: rental.tenant.id, leaseId: rental.lease.id, amount: '1000.00', method: 'CASH', paidAt: new Date().toISOString(), allocations: [{ chargeId: charge.id, amount: '1000.00' }] };
  const results = await Promise.all([client.post('/payments', input, { 'idempotency-key': key }), client.post('/payments', input, { 'idempotency-key': key })]);
  expect(results.map(r => r.status)).toEqual([201, 201]);
  expect(results[0].body).toEqual(results[1].body);
  expect(await prismaOf(app).payment.count({ where: { leaseId: rental.lease.id } })).toBe(1);
});
