import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MailerService } from '../src/mail/mailer.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { Client, createRental, lastEmail, PASSWORD, prismaOf, registerOwner, startApp, today, tokenIn, unique } from './helpers.js';

describe('staff alerts for tenant reports', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let ownerEmail: string;
  let tenant: Client;
  let rental: Awaited<ReturnType<typeof createRental>>;
  const staff: Record<string, string> = {};

  const inbox = (to: string, subject: RegExp) => app.get(MailerService).outbox.filter((m) => m.to === to && subject.test(m.subject));
  /** Alerts are sent after the response; settle any in-flight run, then run once more. */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.get(NotificationsService).processPending();
  }

  beforeAll(async () => {
    app = await startApp();
    const registered = await registerOwner(app);
    owner = registered.client;
    ownerEmail = registered.email;
    rental = await createRental(owner);
    for (const role of ['COLLECTOR', 'MAINTENANCE', 'VIEWER']) {
      const email = `${role.toLowerCase()}-${unique()}@rentflow.test`;
      const invite = await owner.post('/staff/invitations', { email, role });
      await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: role, password: PASSWORD });
      staff[role] = email;
    }
    // Alerts go only to verified addresses; accepted invitations verify, a fresh owner does not.
    await prismaOf(app).user.updateMany({ where: { email: { in: [ownerEmail, ...Object.values(staff)] } }, data: { emailVerifiedAt: new Date() } });

    await owner.post(`/tenants/${rental.tenant.id}/portal/invite`, {});
    const token = tokenIn(lastEmail(app, rental.tenant.email)?.text);
    await new Client(app).post('/staff/invitations/accept', { token, name: 'Tenant', password: PASSWORD });
    tenant = new Client(app);
    await tenant.post('/auth/login', { email: rental.tenant.email, password: PASSWORD });
  });
  afterAll(async () => app.close());

  it('emails owners, managers, and collectors once when a tenant reports a payment', async () => {
    const key = randomUUID();
    const body = { leaseId: rental.lease.id, amount: '2500.00', method: 'GCASH', referenceNumber: 'GC-778899', paidOn: today() };
    expect((await tenant.post('/portal/payment-notices', body, { 'idempotency-key': key })).status).toBe(201);
    await settle();
    // A retried request replays the stored response and must not alert again.
    expect((await tenant.post('/portal/payment-notices', body, { 'idempotency-key': key })).status).toBe(201);
    await settle();

    const subject = /reported a payment of ₱2,500\.00$/;
    expect(inbox(ownerEmail, subject)).toHaveLength(1);
    expect(inbox(staff['COLLECTOR']!, subject)).toHaveLength(1);
    expect(inbox(staff['MAINTENANCE']!, subject)).toHaveLength(0);
    expect(inbox(staff['VIEWER']!, subject)).toHaveLength(0);
    expect(inbox(ownerEmail, subject)[0]!.text).toContain('reference GC-778899');
  });

  it('emails owners, managers, and maintenance staff when a tenant reports a repair', async () => {
    const response = await tenant.post('/portal/maintenance', { title: 'No water in the bathroom', description: 'Since this morning, nothing comes out.', priority: 'URGENT' });
    expect(response.status).toBe(201);
    await settle();
    const subject = /^Urgent repair: No water in the bathroom$/;
    expect(inbox(ownerEmail, subject)).toHaveLength(1);
    expect(inbox(staff['MAINTENANCE']!, subject)).toHaveLength(1);
    expect(inbox(staff['COLLECTOR']!, subject)).toHaveLength(0);
    expect(inbox(staff['MAINTENANCE']!, subject)[0]!.text).toContain(`Unit ${rental.unit.number}`);
  });

  it('retries an alert the mail provider rejected, with backoff', async () => {
    const mailer = app.get(MailerService);
    await settle();
    const failing = vi.spyOn(mailer, 'send').mockRejectedValue(new Error('provider down'));
    const response = await tenant.post('/portal/maintenance', { title: 'Broken window latch', description: 'The latch fell off the bedroom window.', priority: 'LOW' });
    expect(response.status).toBe(201);
    await settle();
    failing.mockRestore();

    const event = await prismaOf(app).outboxEvent.findFirstOrThrow({ where: { aggregateId: response.body.id } });
    expect(event.status).toBe('PENDING');
    expect(event.attempts).toBe(1);
    expect(event.availableAt.getTime()).toBeGreaterThan(Date.now());

    // Not before the backoff has passed…
    await app.get(NotificationsService).processPending();
    expect(inbox(ownerEmail, /Broken window latch/)).toHaveLength(0);
    // …then delivered once.
    await prismaOf(app).outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    await app.get(NotificationsService).processPending();
    await app.get(NotificationsService).processPending();
    expect(inbox(ownerEmail, /Broken window latch/)).toHaveLength(1);
    expect(await prismaOf(app).outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: 'PROCESSED', attempts: 2 });
  });

  it('retries only failed recipients after a partial delivery', async () => {
    await settle();
    const mailer = app.get(MailerService);
    const send = mailer.send.bind(mailer);
    const failure = vi.spyOn(mailer, 'send').mockImplementation(message =>
      message.to === staff['MAINTENANCE'] ? Promise.reject(new Error('temporary failure')) : send(message));
    let eventId: string;
    try {
      const response = await tenant.post('/portal/maintenance', { title: 'Partial delivery regression', description: 'A leaking tap needs repair.', priority: 'LOW' });
      expect(response.status).toBe(201);
      await settle();
      const event = await prismaOf(app).outboxEvent.findFirstOrThrow({ where: { aggregateId: response.body.id } });
      eventId = event.id;
      expect(event.status).toBe('PENDING');
      expect(event.deliveredTo).toEqual([ownerEmail]);
    } finally { failure.mockRestore(); }
    await prismaOf(app).outboxEvent.update({ where: { id: eventId! }, data: { availableAt: new Date(0) } });
    await app.get(NotificationsService).processPending();
    expect(inbox(ownerEmail, /Partial delivery regression/)).toHaveLength(1);
    expect(inbox(staff['MAINTENANCE']!, /Partial delivery regression/)).toHaveLength(1);
    expect(await prismaOf(app).outboxEvent.findUniqueOrThrow({ where: { id: eventId! } })).toMatchObject({ status: 'PROCESSED', attempts: 2 });
  });

  it('exposes exhausted alerts only to managers in their own workspace', async () => {
    const event = await prismaOf(app).outboxEvent.findFirstOrThrow({ where: { aggregateType: 'MaintenanceRequest', deliveredTo: { has: ownerEmail } } });
    await prismaOf(app).outboxEvent.update({ where: { id: event.id }, data: { status: 'FAILED', attempts: 5, lastError: 'Error' } });
    expect((await owner.get('/notifications/failed')).body.some((row: { id: string }) => row.id === event.id)).toBe(true);
    expect((await tenant.get('/notifications/failed')).status).toBe(403);
    const other = await registerOwner(app);
    expect((await other.client.get('/notifications/failed')).body).toEqual([]);
  });
});
