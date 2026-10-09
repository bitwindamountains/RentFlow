import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetEnvironmentCache } from '../src/config/environment.js';
import { MailerService } from '../src/mail/mailer.service.js';
import { Client, createRental, PASSWORD, prismaOf, registerOwner, startApp, tokenIn } from './helpers.js';
import { mailText, smtpSink } from './smtp-sink.js';

describe('production configuration over local services', () => {
  let app: NestFastifyApplication;
  let smtp: Awaited<ReturnType<typeof smtpSink>>;
  let owner: Awaited<ReturnType<typeof registerOwner>>;
  const origin = 'https://rentflow.example.test';

  beforeAll(async () => {
    smtp = await smtpSink();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEB_ORIGIN', origin);
    vi.stubEnv('APP_URL', origin);
    vi.stubEnv('MAIL_PROVIDER', 'smtp');
    vi.stubEnv('MAIL_FROM', 'RentFlow <no-reply@example.test>');
    vi.stubEnv('SMTP_URL', smtp.url);
    vi.stubEnv('MAIL_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('MFA_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    app = await startApp();
    owner = await registerOwner(app);
  });
  afterAll(async () => {
    await app?.close();
    await smtp?.close();
    vi.unstubAllEnvs();
    resetEnvironmentCache();
  });

  it('sets production cookies and security headers, hides docs, and enforces CSRF', async () => {
    const login = await new Client(app).post('/auth/login', { email: owner.email, password: PASSWORD });
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-rentflow_session=/);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Domain=');
    expect((await owner.client.get('/health/ready')).status).toBe(200);
    expect((await app.inject({ url: '/api/docs' })).statusCode).toBe(404);
    const response = await owner.client.get('/auth/me', { origin });
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await owner.client.get('/auth/me', { origin: 'https://untrusted.example.test' })).headers['access-control-allow-origin']).toBeUndefined();
    expect((await owner.client.post('/auth/sessions/revoke-others', {}, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await owner.client.post('/auth/sessions/revoke-others', {})).status).toBe(200);
  });

  it('delivers usable one-time links through the configured SMTP URL without a memory outbox', async () => {
    const verification = smtp.messages.find(message => message.includes(`To: ${owner.email}`));
    expect(verification).toBeDefined();
    const text = mailText(verification!);
    expect(text).toContain(`${origin}/verify-email#token=`);
    const token = tokenIn(text);
    expect((await new Client(app).post('/auth/email/verify', { token })).status).toBe(200);
    expect((await new Client(app).post('/auth/email/verify', { token })).status).toBe(400);
    expect(app.get(MailerService).outbox).toHaveLength(0);
    const queued = await prismaOf(app).mailDelivery.findFirstOrThrow({ where: { userId: owner.profile.user.id, kind: 'EMAIL_VERIFICATION' } });
    expect(queued).toMatchObject({ status: 'PROCESSED', encryptedBody: null });
    expect(verification!.replace(/\r\n[ \t]+/g, ' ')).toContain(`Message-ID: <mail-${queued.id}@rentflow.example.test>`);
  });

  it('keeps a temporary SMTP failure durable and retries a working password-reset link', async () => {
    smtp.rejectOnce();
    const before = smtp.messages.length;
    expect((await new Client(app).post('/auth/password/forgot', { email: owner.email })).status).toBe(202);
    expect(smtp.messages).toHaveLength(before);
    const db = prismaOf(app);
    const queued = await db.mailDelivery.findFirstOrThrow({ where: { userId: owner.profile.user.id, kind: 'PASSWORD_RESET' } });
    expect(queued).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(queued.encryptedBody).not.toContain('token=');
    await db.mailDelivery.update({ where: { id: queued.id }, data: { availableAt: new Date(0) } });
    await app.get(MailerService).processPending();
    expect(smtp.messages).toHaveLength(before + 1);
    const token = tokenIn(mailText(smtp.messages.at(-1)!));
    expect((await new Client(app).post('/auth/password/reset', { token, password: 'a new local test password' })).status).toBe(200);
    expect((await owner.client.get('/auth/me')).status).toBe(401);
    expect((await owner.client.post('/auth/login', { email: owner.email, password: 'a new local test password' })).status).toBe(200);
    expect(await db.mailDelivery.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'PROCESSED', attempts: 2, encryptedBody: null });
  });

  it('stores files privately using an absolute local path under production settings', async () => {
    const rental = await createRental(owner.client);
    const pdf = Buffer.from('%PDF-1.7\nLocal production storage check\n%%EOF');
    const uploaded = await owner.client.request('POST', `/documents/files?name=Lease&category=Lease&entityType=Tenant&entityId=${rental.tenant.id}`, pdf, { 'content-type': 'application/pdf' });
    expect(uploaded.status).toBe(201);
    expect((await owner.client.get(`/documents/${uploaded.body.id}/file`)).raw).toEqual(pdf);
    expect((await new Client(app).get(`/documents/${uploaded.body.id}/file`)).status).toBe(401);
    expect((await owner.client.delete(`/documents/${uploaded.body.id}`)).status).toBe(200);
    expect((await owner.client.get(`/documents/${uploaded.body.id}/file`)).status).toBe(404);
  });
});
