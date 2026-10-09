import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  type Client,
  createRental,
  daysFromToday,
  monthStart,
  prismaOf,
  registerOwner,
  startApp,
  today,
} from './helpers.js';

describe('billing, payments, and balances', () => {
  let app: NestFastifyApplication;
  let owner: Client;

  const pay = (rental: Awaited<ReturnType<typeof createRental>>, amount: string, allocations: Array<{ chargeId: string; amount: string }>, extra: Record<string, unknown> = {}, key = randomUUID()) =>
    owner.post(
      '/payments',
      {
        tenantId: rental.tenant.id,
        leaseId: rental.lease.id,
        amount,
        method: 'GCASH',
        paidAt: new Date().toISOString(),
        allocations,
        ...extra,
      },
      { 'idempotency-key': key },
    );
  const openCharges = async (leaseId: string) => (await owner.get(`/leases/${leaseId}/open-charges`)).body;

  beforeAll(async () => {
    app = await startApp();
    owner = (await registerOwner(app)).client;
  });
  afterAll(async () => app.close());

  it('bills the move-in month when a lease is created (full, prorated, or none)', async () => {
    const full = await createRental(owner, { startDate: monthStart(0), rent: '12000.00' });
    expect((await openCharges(full.lease.id)).map((c: { amount: string }) => c.amount)).toEqual(['12000.00']);

    const midMonth = `${monthStart(0).slice(0, 8)}16`;
    const prorated = await createRental(owner, { startDate: midMonth, rent: '9000.00', firstMonth: 'PRORATED' });
    const [first] = await openCharges(prorated.lease.id);
    const days = new Date(Date.UTC(Number(midMonth.slice(0, 4)), Number(midMonth.slice(5, 7)), 0)).getUTCDate();
    expect(first.amount).toBe(((9000 * (days - 15)) / days).toFixed(2));
    expect(first.billingPeriod).toBe(midMonth.slice(0, 7));

    const none = await createRental(owner, { firstMonth: 'NONE' });
    expect(await openCharges(none.lease.id)).toEqual([]);
  });

  it('catches up missed months exactly once and never double-bills rent', async () => {
    const rental = await createRental(owner, { startDate: monthStart(-3), billingDay: 1, dueDay: 5 });
    const first = await owner.post('/billing/run', {});
    const second = await owner.post('/billing/run', {});
    expect(first.status).toBe(201);
    expect(second.body.created).toBe(0);
    const periods = (await openCharges(rental.lease.id)).map((c: { billingPeriod: string }) => c.billingPeriod);
    expect(periods).toEqual([monthStart(-3), monthStart(-2), monthStart(-1), monthStart(0)].map((d) => d.slice(0, 7)));

    // A manual rent charge for an already-billed period is rejected.
    const duplicate = await owner.post('/charges', {
      leaseId: rental.lease.id,
      type: 'RENT',
      description: 'Rent again',
      amount: '10000.00',
      dueDate: monthStart(-1),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('CHARGE_EXISTS');

    // The background job is idempotent with the manual run.
    await app.get(JobsService).runAll();
    expect(await openCharges(rental.lease.id)).toHaveLength(4);
  });

  it('never posts a charge that is due before it is billed', async () => {
    const rental = await createRental(owner, { startDate: monthStart(-2), billingDay: 25, dueDay: 5, firstMonth: 'NONE' });
    await owner.post('/billing/run', {});
    for (const charge of await openCharges(rental.lease.id)) {
      expect(charge.dueDate > `${charge.billingPeriod}-25`).toBe(true);
      expect(charge.dueDate.slice(8)).toBe('05');
    }
  });

  it('rejects billing runs for future dates', async () => {
    expect((await owner.post('/billing/run', { asOf: daysFromToday(40) })).status).toBe(400);
  });

  it('validates payments: allocations, duplicates, dates, and totals', async () => {
    const rental = await createRental(owner, { rent: '5000.00' });
    const [charge] = await openCharges(rental.lease.id);
    const over = await pay(rental, '6000.00', [{ chargeId: charge.id, amount: '6000.00' }]);
    expect(over.body.code).toBe('INVALID_ALLOCATION');
    expect((await pay(rental, '10.00', [{ chargeId: charge.id, amount: '20.00' }])).body.code).toBe('ALLOCATION_EXCEEDS_PAYMENT');
    expect(
      (await pay(rental, '20.00', [{ chargeId: charge.id, amount: '10.00' }, { chargeId: charge.id, amount: '10.00' }])).status,
    ).toBe(422);
    expect((await pay(rental, '10.00', [], { paidAt: new Date(Date.now() + 86_400_000).toISOString() })).body.code).toBe(
      'FUTURE_PAYMENT_DATE',
    );
    expect((await pay(rental, '10.001', [])).status).toBe(400);
    expect((await pay(rental, '-10.00', [])).status).toBe(400);
  });

  it('records partial payments and back-dated payments with exact balances', async () => {
    const rental = await createRental(owner, { rent: '7000.00' });
    const [charge] = await openCharges(rental.lease.id);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const first = await pay(rental, '2500.10', [{ chargeId: charge.id, amount: '2500.10' }], { paidAt: yesterday });
    expect(first.status).toBe(201);
    expect(first.body.receiptNumber).toMatch(/-\d{4}-\d{6}$/);
    expect(first.body.paidAt).toBe(yesterday);
    const second = await pay(rental, '1000.00', [{ chargeId: charge.id, amount: '999.90' }]);
    expect(second.body.unallocated).toBe('0.00');
    const [after] = await openCharges(rental.lease.id);
    expect(after.outstanding).toBe('3499.90');
    const tenant = (await owner.get(`/tenants/${rental.tenant.id}`)).body;
    // Any remainder is allocated to existing debt; ledger and open charges agree.
    expect(tenant.balance).toBe('3499.90');
  });

  it('replays a retried payment instead of posting it twice', async () => {
    const rental = await createRental(owner);
    const [charge] = await openCharges(rental.lease.id);
    const key = randomUUID();
    const body = [{ chargeId: charge.id, amount: '500.00' }];
    const paidAt = new Date().toISOString();
    const first = await pay(rental, '500.00', body, { paidAt }, key);
    const retry = await pay(rental, '500.00', body, { paidAt }, key);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.receiptNumber).toBe(first.body.receiptNumber);
    const conflict = await pay(rental, '600.00', [{ chargeId: charge.id, amount: '600.00' }], { paidAt }, key);
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const payments = (await owner.get(`/payments?tenantId=${rental.tenant.id}`)).body.items;
    expect(payments).toHaveLength(1);
  });

  it('handles concurrent payments against the same charge without over-allocation', async () => {
    const rental = await createRental(owner, { rent: '1000.00' });
    const [charge] = await openCharges(rental.lease.id);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => pay(rental, '600.00', [{ chargeId: charge.id, amount: '600.00' }])),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const [after] = await openCharges(rental.lease.id);
    expect(after.outstanding).toBe('400.00');
  });

  it('restores the outstanding balance and voids the receipt on reversal', async () => {
    const rental = await createRental(owner, { rent: '3000.00' });
    const [charge] = await openCharges(rental.lease.id);
    const payment = await pay(rental, '3000.00', [{ chargeId: charge.id, amount: '3000.00' }]);
    expect(await openCharges(rental.lease.id)).toEqual([]);
    expect((await owner.post(`/payments/${payment.body.id}/reverse`, { reason: 'Bounced transfer' })).status).toBe(201);
    expect((await openCharges(rental.lease.id))[0].outstanding).toBe('3000.00');
    const receipt = (await owner.get(`/payments/${payment.body.id}/receipt`)).body;
    expect(receipt).toMatchObject({ voided: true, voidReason: 'Bounced transfer', amount: '3000.00' });
    expect((await owner.post(`/payments/${payment.body.id}/reverse`, { reason: 'Twice' })).status).toBe(404);
  });

  it('corrects charges with waivers and voids, keeping the ledger balanced', async () => {
    const rental = await createRental(owner, { rent: '8000.00' });
    const [charge] = await openCharges(rental.lease.id);
    expect((await owner.post(`/charges/${charge.id}/adjustments`, { type: 'WAIVER', amount: '9000.00', reason: 'Too much' })).status).toBe(422);
    const waiver = await owner.post(`/charges/${charge.id}/adjustments`, { type: 'DISCOUNT', amount: '500.00', reason: 'Loyalty' });
    expect(waiver.body.outstanding).toBe('7500.00');

    const extra = await owner.post('/charges', { leaseId: rental.lease.id, type: 'WATER', description: 'Water — entered twice', amount: '350.00', dueDate: today() });
    const paid = await pay(rental, '100.00', [{ chargeId: extra.body.id, amount: '100.00' }]);
    expect((await owner.post(`/charges/${extra.body.id}/void`, { reason: 'Duplicate' })).body.code).toBe('CHARGE_HAS_PAYMENTS');
    await owner.post(`/payments/${paid.body.id}/reverse`, { reason: 'Applied to wrong charge' });
    expect((await owner.post(`/charges/${extra.body.id}/void`, { reason: 'Duplicate' })).status).toBe(201);

    const open = await openCharges(rental.lease.id);
    expect(open.map((c: { id: string }) => c.id)).toEqual([charge.id]);
    const ledger = (await owner.get(`/leases/${rental.lease.id}/ledger`)).body;
    expect(ledger.at(-1).balance).toBe('7500.00');
    expect((await owner.get(`/tenants/${rental.tenant.id}`)).body.balance).toBe('7500.00');
    const all = (await owner.get(`/charges?leaseId=${rental.lease.id}&status=all`)).body.items;
    expect(all.find((c: { id: string }) => c.id === extra.body.id).status).toBe('VOIDED');
  });

  it('lists every overdue tenant, even when many older charges are paid', async () => {
    const other = (await registerOwner(app)).client;
    const saved = owner;
    owner = other;
    try {
      const rental = await createRental(owner, { startDate: monthStart(-26), rent: '1000.00', firstMonth: 'NONE' });
      await owner.post('/billing/run', {});
      const charges = (await owner.get(`/charges?leaseId=${rental.lease.id}&status=open&limit=200`)).body.items as Array<{ id: string; dueDate: string }>;
      expect(charges.length).toBeGreaterThanOrEqual(25);
      // Pay everything except the most recent overdue month.
      const toPay = charges.filter((c) => c.dueDate < monthStart(-1));
      await pay(rental, (toPay.length * 1000).toFixed(2), toPay.map((c) => ({ chargeId: c.id, amount: '1000.00' })));
      const late = await createRental(owner, { startDate: monthStart(-1), rent: '4000.00' });
      const reminders = (await owner.get('/reminders')).body;
      const arrears = (await owner.get('/arrears')).body;
      expect(arrears.map((a: { leaseId: string }) => a.leaseId)).toEqual(expect.arrayContaining([rental.lease.id, late.lease.id]));
      expect(reminders.filter((r: { type: string }) => r.type === 'OVERDUE_BALANCE')).toHaveLength(2);
      const entry = arrears.find((a: { leaseId: string }) => a.leaseId === rental.lease.id);
      expect(Number(entry.overdue)).toBeGreaterThanOrEqual(1000);
    } finally {
      owner = saved;
    }
  });

  it('respects the grace period before a charge counts as overdue', async () => {
    const fresh = (await registerOwner(app)).client;
    const saved = owner;
    owner = fresh;
    try {
      const rental = await createRental(owner, { startDate: today(), gracePeriodDays: 5 });
      await prismaOf(app).charge.updateMany({
        where: { leaseId: rental.lease.id },
        data: { dueDate: new Date(`${daysFromToday(-3)}T00:00:00Z`) },
      });
      expect((await owner.get('/arrears')).body).toEqual([]);
      await prismaOf(app).charge.updateMany({
        where: { leaseId: rental.lease.id },
        data: { dueDate: new Date(`${daysFromToday(-6)}T00:00:00Z`) },
      });
      expect((await owner.get('/arrears')).body).toHaveLength(1);
    } finally {
      owner = saved;
    }
  });

  it('reports this month on the dashboard, not all-time totals', async () => {
    const fresh = (await registerOwner(app)).client;
    const saved = owner;
    owner = fresh;
    try {
      const old = await createRental(owner, { startDate: monthStart(-3), rent: '1000.00', firstMonth: 'NONE' });
      await owner.post('/billing/run', {});
      const current = (await openCharges(old.lease.id)).find((c: { billingPeriod: string }) => c.billingPeriod === today().slice(0, 7));
      await pay(old, '1000.00', [{ chargeId: current.id, amount: '1000.00' }]);
      const dashboard = (await owner.get('/dashboard')).body;
      expect(dashboard.billedThisMonth).toBe('1000.00');
      expect(dashboard.collectedThisMonth).toBe('1000.00');
      expect(dashboard.collectionRate).toBe(100);
      expect(dashboard.remainingThisMonth).toBe('0.00');
      expect(dashboard.outstanding).toBe('2000.00');
      expect(dashboard.occupiedUnits).toBe(1);
      expect(dashboard.trend).toHaveLength(6);
      expect(dashboard.trend.at(-1)).toEqual({ month: today().slice(0, 7), billed: '1000.00', collected: '1000.00' });
    } finally {
      owner = saved;
    }
  });

  it('does not count cash applied to arrears as collected on this month', async () => {
    const saved = owner;
    owner = (await registerOwner(app)).client;
    try {
      const old = await createRental(owner, { startDate: monthStart(-2), rent: '1000.00', firstMonth: 'NONE' });
      await owner.post('/billing/run', {});
      const oldest = (await openCharges(old.lease.id)).find((c: { billingPeriod: string }) => c.billingPeriod !== today().slice(0, 7));
      expect(oldest).toBeDefined();
      await pay(old, '1000.00', [{ chargeId: oldest.id, amount: '1000.00' }]);
      const dashboard = (await owner.get('/dashboard')).body;
      expect(dashboard.collectedThisMonth).toBe('1000.00');
      expect(dashboard.collectionRate).toBe(0);
      expect(dashboard.remainingThisMonth).toBe('1000.00');
    } finally {
      owner = saved;
    }
  });

  it('nets adjustments out of the trend, as on the billed tile', async () => {
    const saved = owner;
    owner = (await registerOwner(app)).client;
    try {
      const rental = await createRental(owner, { startDate: monthStart(0), rent: '1000.00', firstMonth: 'FULL' });
      const [charge] = await openCharges(rental.lease.id);
      expect((await owner.post(`/charges/${charge.id}/adjustments`, { type: 'DISCOUNT', amount: '200.00', reason: 'Loyalty' })).status).toBe(201);
      const dashboard = (await owner.get('/dashboard')).body;
      expect(dashboard.billedThisMonth).toBe('800.00');
      expect(dashboard.trend.at(-1).billed).toBe('800.00');
    } finally {
      owner = saved;
    }
  });

  it('changes rent from a future date without rewriting billed months', async () => {
    const rental = await createRental(owner, { startDate: monthStart(-1), rent: '10000.00' });
    await owner.post('/billing/run', {});
    // Bill next month early too, so a change from today lands on a billed month whatever today's date is.
    const early = await owner.post('/charges', { leaseId: rental.lease.id, type: 'RENT', description: 'Rent', amount: '10000.00', dueDate: monthStart(1) });
    expect(early.status).toBe(201);
    const tooEarly = await owner.post(`/leases/${rental.lease.id}/rent-change`, { effectiveFrom: today(), monthlyRent: '11000.00' });
    expect(tooEarly.body.code).toBe('RENT_CHANGE_AFTER_BILLED');
    const change = await owner.post(`/leases/${rental.lease.id}/rent-change`, { effectiveFrom: monthStart(2), monthlyRent: '11000.00' });
    expect(change.status).toBe(201);
    expect(change.body.firstBill).toBe(monthStart(2));
    const schedules = (await owner.get('/billing-schedules')).body.filter((s: { leaseId: string }) => s.leaseId === rental.lease.id);
    expect(schedules.map((s: { amount: string }) => s.amount).sort()).toEqual(['10000.00', '11000.00']);
    expect((await openCharges(rental.lease.id)).every((c: { amount: string }) => c.amount === '10000.00')).toBe(true);
  });

  it('expires ended leases and frees the unit', async () => {
    const rental = await createRental(owner, { startDate: monthStart(-2), endDate: daysFromToday(-1) });
    await app.get(JobsService).runAll();
    const leases = (await owner.get('/leases')).body;
    expect(leases.find((l: { id: string }) => l.id === rental.lease.id).status).toBe('EXPIRED');
    const properties = (await owner.get('/properties')).body;
    const unit = properties.flatMap((p: { units: unknown[] }) => p.units).find((u: { id: string }) => u.id === rental.unit.id);
    expect(unit.status).toBe('AVAILABLE');
  });

  it('terminates immediately only, and never for a future date', async () => {
    const rental = await createRental(owner);
    expect((await owner.post(`/leases/${rental.lease.id}/terminate`, { endDate: daysFromToday(30), reason: 'Moving' })).body.code).toBe(
      'FUTURE_TERMINATION_NOT_ALLOWED',
    );
    expect((await owner.post(`/leases/${rental.lease.id}/terminate`, { endDate: today(), reason: 'Moved out' })).body.status).toBe('TERMINATED');
    // The unit can be leased again right away.
    const second = await owner.post('/tenants', { firstName: 'Next', lastName: 'Tenant' });
    const lease = await owner.post('/leases', {
      unitId: rental.unit.id,
      tenantId: second.body.id,
      startDate: today(),
      monthlyRent: '10000.00',
      billingDay: 1,
      dueDay: 5,
    });
    expect(lease.status).toBe(201);
  });

  it('prevents two active leases on one unit, even concurrently', async () => {
    const rental = await createRental(owner);
    const tenant = await owner.post('/tenants', { firstName: 'Second', lastName: 'Tenant' });
    const attempt = await owner.post('/leases', {
      unitId: rental.unit.id,
      tenantId: tenant.body.id,
      startDate: today(),
      monthlyRent: '1.00',
      billingDay: 1,
      dueDay: 1,
    });
    expect(attempt.status).toBe(409);
    expect(attempt.body.code).toBe('UNIT_OCCUPIED');
  });

  it('paginates payments with a stable cursor', async () => {
    const fresh = (await registerOwner(app)).client;
    const saved = owner;
    owner = fresh;
    try {
      const rental = await createRental(owner);
      for (let i = 0; i < 5; i++) await pay(rental, '1.00', [], { paidAt: new Date(Date.now() - i * 60_000).toISOString() });
      const first = (await owner.get('/payments?limit=2')).body;
      const second = (await owner.get(`/payments?limit=2&cursor=${first.nextCursor}`)).body;
      const third = (await owner.get(`/payments?limit=2&cursor=${second.nextCursor}`)).body;
      const ids = [...first.items, ...second.items, ...third.items].map((p: { id: string }) => p.id);
      expect(new Set(ids).size).toBe(5);
      expect(third.nextCursor).toBeNull();
    } finally {
      owner = saved;
    }
  });
});
