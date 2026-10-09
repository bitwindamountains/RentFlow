import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MailerService } from '../src/mail/mailer.service.js';
import { Client, prismaOf, registerOwner, startApp, unique } from './helpers.js';

describe('durable transactional email', () => {
  let app: NestFastifyApplication;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  beforeAll(async () => { app = await startApp(); owner = await registerOwner(app); });
  afterAll(async () => { await app.close(); });

  it('recovers a failed password reset on a new worker and clears the encrypted payload', async () => {
    const mailer = app.get(MailerService);
    const failure = vi.spyOn(mailer, 'send').mockRejectedValueOnce(new Error('provider unavailable'));
    try { expect((await new Client(app).post('/auth/password/forgot', { email: owner.email })).status).toBe(202); }
    finally { failure.mockRestore(); }
    const db = prismaOf(app);
    const row = await db.mailDelivery.findFirstOrThrow({ where: { kind: 'PASSWORD_RESET', userId: owner.profile.user.id }, orderBy: { createdAt: 'desc' } });
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row.encryptedBody).toMatch(/^v1:/);
    expect(row.encryptedBody).not.toContain(owner.email);
    expect(row.encryptedBody).not.toContain('token=');
    await db.mailDelivery.update({ where: { id: row.id }, data: { availableAt: new Date(0) } });
    const restarted = new MailerService(db);
    await restarted.processPending();
    expect(restarted.outbox).toHaveLength(1);
    expect(restarted.outbox[0]).toMatchObject({ to: owner.email, idempotencyKey: `mail-${row.id}` });
    expect(restarted.outbox[0]!.text).toContain('#token=');
    expect(await db.mailDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'PROCESSED', attempts: 2, encryptedBody: null });
    await restarted.processPending();
    expect(restarted.outbox).toHaveLength(1);
    await restarted.onModuleDestroy();
  });

  it('rolls back an invitation if its durable email cannot be saved', async () => {
    const email = `invite-${unique()}@rentflow.test`;
    const failure = vi.spyOn(app.get(MailerService), 'enqueue').mockRejectedValueOnce(new Error('queue unavailable'));
    try { expect((await owner.client.post('/staff/invitations', { email, role: 'VIEWER' })).status).toBe(500); }
    finally { failure.mockRestore(); }
    expect(await prismaOf(app).staffInvitation.count({ where: { email } })).toBe(0);
  });

  it('does not deliver expired or replaced secret links', async () => {
    const db = prismaOf(app);
    const mailer = app.get(MailerService);
    const send = vi.spyOn(mailer, 'send').mockRejectedValue(new Error('provider unavailable'));
    try {
      await new Client(app).post('/auth/password/forgot', { email: owner.email });
      await new Client(app).post('/auth/password/forgot', { email: owner.email });
    } finally { send.mockRestore(); }
    const rows = await db.mailDelivery.findMany({ where: { kind: 'PASSWORD_RESET', status: 'PENDING', userId: owner.profile.user.id }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    await db.mailDelivery.update({ where: { id: rows[0]!.id }, data: { availableAt: new Date(0) } });
    await db.mailDelivery.update({ where: { id: rows[1]!.id }, data: { expiresAt: new Date(0) } });
    const restarted = new MailerService(db);
    await restarted.processPending();
    expect(restarted.outbox).toHaveLength(0);
    expect(await db.mailDelivery.findUniqueOrThrow({ where: { id: rows[0]!.id } })).toMatchObject({ encryptedBody: null, lastError: 'CANCELLED' });
    expect(await db.mailDelivery.findUniqueOrThrow({ where: { id: rows[1]!.id } })).toMatchObject({ encryptedBody: null, lastError: 'EXPIRED' });
    await restarted.onModuleDestroy();
  });

  it('claims a message only once across concurrent workers and scopes retry access', async () => {
    const db = prismaOf(app);
    const mailer = app.get(MailerService);
    const id = await db.$transaction(tx => mailer.enqueue(tx, { to: owner.email, subject: 'Recovery test', text: 'Durable message' }, 'TEST', { organizationId: owner.profile.organization.id }));
    const other = new MailerService(db);
    await Promise.all([mailer.processPending(), other.processPending()]);
    expect([...mailer.outbox, ...other.outbox].filter(m => m.idempotencyKey === `mail-${id}`)).toHaveLength(1);
    const failedId = await db.$transaction(tx => mailer.enqueue(tx, { to: owner.email, subject: 'Retry test', text: 'Message' }, 'TEST', { organizationId: owner.profile.organization.id }));
    await db.mailDelivery.update({ where: { id: failedId }, data: { status: 'FAILED', attempts: 8 } });
    const outsider = await registerOwner(app);
    expect((await outsider.client.get('/notifications/mail/failed')).body.map((r: { id: string }) => r.id)).not.toContain(failedId);
    expect((await outsider.client.post(`/notifications/mail/${failedId}/retry`)).status).toBe(404);
    const listed = (await owner.client.get('/notifications/mail/failed')).body.find((r: { id: string }) => r.id === failedId);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('encryptedBody');
    expect((await owner.client.post(`/notifications/mail/${failedId}/retry`)).status).toBe(201);
    expect(await db.mailDelivery.findUniqueOrThrow({ where: { id: failedId } })).toMatchObject({ status: 'PROCESSED', encryptedBody: null });
    await other.onModuleDestroy();
  });
});
