import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays } from '../src/common/dates.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { MailerService } from '../src/mail/mailer.service.js';
import { RemindersService } from '../src/reminders/reminders.service.js';
import { Client, createRental, PASSWORD, prismaOf, registerOwner, startApp, unique } from './helpers.js';

type Rental = Awaited<ReturnType<typeof createRental>>;

describe('automated reminders', () => {
  let app: NestFastifyApplication;
  let reminders: RemindersService;

  /** A fresh workspace per test keeps each run's emails to that test's leases. */
  async function workspace() {
    const { client, email } = await registerOwner(app);
    await prismaOf(app).user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    return { owner: client, ownerEmail: email };
  }
  const orgOf = async (rental: Rental) =>
    (await prismaOf(app).lease.findUniqueOrThrow({ where: { id: rental.lease.id } })).organizationId;
  const dueDateOf = async (owner: Client, rental: Rental): Promise<string> =>
    (await owner.get(`/leases/${rental.lease.id}/open-charges`)).body[0].dueDate;
  const sentTo = (to: string) => app.get(MailerService).outbox.filter((message) => message.to === to);
  const alertsTo = (to: string) => sentTo(to).filter((message) => message.subject.startsWith('Lease ending'));

  beforeAll(async () => {
    app = await startApp();
    reminders = app.get(RemindersService);
  });
  afterAll(async () => app.close());

  it('keeps tenant reminders off until an owner turns them on, and validates the rules', async () => {
    const { owner } = await workspace();
    const defaults = await owner.get('/settings/reminders');
    expect(defaults.status).toBe(200);
    expect(defaults.body).toEqual({
      tenantReminders: false,
      daysBeforeDue: 3,
      onDueDate: true,
      overdueDays: [3, 7],
      staffLeaseAlerts: true,
      leaseExpiryDays: [60, 30, 7],
    });

    for (const invalid of [{ overdueDays: [0] }, { overdueDays: [1, 2, 3, 4] }, { daysBeforeDue: 15 }, { leaseExpiryDays: [121] }, { tenantReminders: 'yes' }])
      expect((await owner.patch('/settings/reminders', invalid)).status, JSON.stringify(invalid)).toBe(400);

    const updated = await owner.patch('/settings/reminders', { tenantReminders: true, overdueDays: [10, 1, 10] });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ tenantReminders: true, overdueDays: [1, 10], daysBeforeDue: 3 });
    // A partial update leaves the other rules alone.
    const partial = await owner.patch('/settings/reminders', { onDueDate: false });
    expect(partial.body).toMatchObject({ tenantReminders: true, onDueDate: false, overdueDays: [1, 10], leaseExpiryDays: [60, 30, 7] });
    const audit = await owner.get('/audit-log?entityType=Organization');
    expect(audit.body.some((row: { action: string }) => row.action === 'REMINDER_SETTINGS_UPDATED')).toBe(true);
  });

  it('lets only owners and managers see or change reminder rules', async () => {
    const { owner } = await workspace();
    for (const role of ['MANAGER', 'COLLECTOR', 'VIEWER', 'MAINTENANCE']) {
      const email = `${role.toLowerCase()}-${unique()}@rentflow.test`;
      const invite = await owner.post('/staff/invitations', { email, role });
      await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: role, password: PASSWORD });
      const staff = new Client(app);
      await staff.post('/auth/login', { email, password: PASSWORD });
      const expected = role === 'MANAGER' ? 200 : 403;
      expect((await staff.get('/settings/reminders')).status, role).toBe(expected);
      expect((await staff.patch('/settings/reminders', { tenantReminders: true })).status, role).toBe(expected);
      expect((await staff.get('/reminders/sent')).status, role).toBe(expected);
    }
  });

  it('emails a tenant before, on, and after the due date — each step once', async () => {
    const { owner } = await workspace();
    const rental = await createRental(owner, { rent: '9500.00' });
    const organizationId = await orgOf(rental);
    const due = await dueDateOf(owner, rental);
    const tenantEmail = rental.tenant.email as string;

    // Off by default: nothing goes to tenants.
    await reminders.run(organizationId, addDays(due, -3));
    expect(sentTo(tenantEmail)).toHaveLength(0);

    await owner.patch('/settings/reminders', { tenantReminders: true });
    await reminders.run(organizationId, addDays(due, -5));
    expect(sentTo(tenantEmail)).toHaveLength(0);

    await reminders.run(organizationId, addDays(due, -3));
    await reminders.run(organizationId, addDays(due, -3));
    await reminders.run(organizationId, addDays(due, -2));
    expect(sentTo(tenantEmail)).toHaveLength(1);
    const soon = sentTo(tenantEmail)[0]!;
    expect(soon.subject).toMatch(/^Reminder: ₱9,500\.00 due /);
    expect(soon.text).toContain(`Unit ${rental.unit.number}`);
    expect(soon.text).toContain("If you've already paid, you can ignore this message.");

    await reminders.run(organizationId, due);
    expect(sentTo(tenantEmail).at(-1)!.subject).toBe('Due today: ₱9,500.00');

    await reminders.run(organizationId, addDays(due, 3));
    expect(sentTo(tenantEmail).at(-1)!.subject).toMatch(/^Overdue: ₱9,500\.00/);
    expect(sentTo(tenantEmail)).toHaveLength(3);

    const log = await owner.get('/reminders/sent');
    expect(log.body.map((row: { kind: string }) => row.kind).sort()).toEqual(['RENT_DUE_SOON', 'RENT_DUE_TODAY', 'RENT_OVERDUE']);
    expect(log.body[0]).toMatchObject({ status: 'SENT', recipients: 1, tenantId: rental.tenant.id, unitNumber: rental.unit.number });
  });

  it('does not chase tenants who have paid or have reported a payment', async () => {
    const { owner } = await workspace();
    await owner.patch('/settings/reminders', { tenantReminders: true });
    const paid = await createRental(owner, { rent: '5000.00' });
    const reported = await createRental(owner, { rent: '5000.00' });
    const organizationId = await orgOf(paid);
    const due = await dueDateOf(owner, paid);

    const [charge] = (await owner.get(`/leases/${paid.lease.id}/open-charges`)).body;
    const payment = await owner.post('/payments', {
      tenantId: paid.tenant.id,
      leaseId: paid.lease.id,
      amount: '5000.00',
      method: 'CASH',
      paidAt: new Date().toISOString(),
      allocations: [{ chargeId: charge.id, amount: '5000.00' }],
    });
    expect(payment.status).toBe(201);

    const owners = await prismaOf(app).membership.findFirstOrThrow({ where: { organizationId, role: 'OWNER' } });
    await prismaOf(app).paymentNotice.create({
      data: {
        organizationId,
        tenantId: reported.tenant.id,
        leaseId: reported.lease.id,
        amount: '5000.00',
        method: 'GCASH',
        paidOn: new Date(),
        submittedBy: owners.userId,
      },
    });

    await reminders.run(organizationId, due);
    expect(sentTo(paid.tenant.email)).toHaveLength(0);
    expect(sentTo(reported.tenant.email)).toHaveLength(0);
  });

  it('retries a failed send on a later run, then stops', async () => {
    const { owner } = await workspace();
    await owner.patch('/settings/reminders', { tenantReminders: true });
    const rental = await createRental(owner);
    const organizationId = await orgOf(rental);
    const due = await dueDateOf(owner, rental);
    const mailer = app.get(MailerService);

    const failing = vi.spyOn(mailer, 'send').mockRejectedValueOnce(new Error('provider down'));
    expect(await reminders.run(organizationId, due)).toMatchObject({ sent: 0, failed: 1 });
    failing.mockRestore();
    expect(await reminders.run(organizationId, due)).toMatchObject({ sent: 1, failed: 0 });
    expect(await reminders.run(organizationId, due)).toMatchObject({ sent: 0, failed: 0 });

    const row = await prismaOf(app).reminderDelivery.findFirstOrThrow({ where: { leaseId: rental.lease.id, kind: 'RENT_DUE_TODAY' } });
    expect(row).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('alerts verified owners and managers before a lease ends, once per step', async () => {
    const { owner, ownerEmail } = await workspace();
    const rental = await createRental(owner, { endDate: addDays(new Date().toISOString().slice(0, 10), 200) });
    const organizationId = await orgOf(rental);
    const endDate = rental.lease.endDate as string;

    await reminders.run(organizationId, addDays(endDate, -31));
    expect(alertsTo(ownerEmail)).toHaveLength(0);
    await reminders.run(organizationId, addDays(endDate, -30));
    await reminders.run(organizationId, addDays(endDate, -29));
    expect(alertsTo(ownerEmail)).toHaveLength(1);
    expect(alertsTo(ownerEmail)[0]!.subject).toContain(`Unit ${rental.unit.number}`);
    expect(alertsTo(ownerEmail)[0]!.text).toContain('in 30 days');

    await owner.patch('/settings/reminders', { staffLeaseAlerts: false });
    await reminders.run(organizationId, addDays(endDate, -7));
    expect(alertsTo(ownerEmail)).toHaveLength(1);
  });

  it('runs from the background job only from 8:00 in the workspace time zone', async () => {
    const { owner } = await workspace();
    await owner.patch('/settings/reminders', { tenantReminders: true });
    const rental = await createRental(owner);
    const due = await dueDateOf(owner, rental);
    const jobs = app.get(JobsService);

    // 07:30 and 08:30 Manila (UTC+8) on the due date.
    await jobs.runAll(new Date(`${addDays(due, -1)}T23:30:00Z`));
    expect(sentTo(rental.tenant.email)).toHaveLength(0);
    await jobs.runAll(new Date(`${due}T00:30:00Z`));
    expect(sentTo(rental.tenant.email).map((message) => message.subject)).toContain('Due today: ₱10,000.00');
  });
});
