import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomBytes, scryptSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, lastEmail, PASSWORD, prismaOf, registerOwner, startApp, tokenIn, unique } from './helpers.js';

describe('authentication', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => app.close());

  it('rejects unauthenticated access to every private route', async () => {
    const anonymous = new Client(app);
    for (const path of ['/auth/me', '/dashboard', '/tenants', '/payments', '/charges', '/staff', '/reports/financial'])
      expect((await anonymous.get(path)).status, path).toBe(401);
  });

  it('registers an owner with an httpOnly, SameSite=Strict session cookie and sends verification', async () => {
    const client = new Client(app);
    const email = `new-${unique()}@rentflow.test`;
    const response = await client.post('/auth/register', {
      email,
      password: PASSWORD,
      name: 'Maria Santos',
      organizationName: `Santos Rentals ${unique()}`,
    });
    expect(response.status).toBe(201);
    expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(response.headers['set-cookie'])).toMatch(/SameSite=Strict/i);
    expect(response.body).toMatchObject({ role: 'OWNER', user: { email, emailVerified: false } });
    expect(response.body.csrfToken).toBeTruthy();

    const token = tokenIn(lastEmail(app, email)?.text);
    expect((await new Client(app).post('/auth/email/verify', { token })).status).toBe(200);
    expect((await client.get('/auth/me')).body.user.emailVerified).toBe(true);
    // Single use.
    expect((await new Client(app).post('/auth/email/verify', { token })).status).toBe(400);
  });

  it('enforces the password policy and rejects duplicate emails', async () => {
    const email = `policy-${unique()}@rentflow.test`;
    const weak = await new Client(app).post('/auth/register', {
      email,
      password: `${email.split('@')[0]}-2026!`,
      name: 'Weak',
      organizationName: 'Weak Org',
    });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('PASSWORD_TOO_WEAK');
    await registerOwner(app, email.split('@')[0]!.replace('owner-', ''));
  });

  it('returns the same generic error for a wrong password and an unknown email', async () => {
    const { email } = await registerOwner(app);
    const wrong = await new Client(app).post('/auth/login', { email, password: 'not the password at all' });
    const unknown = await new Client(app).post('/auth/login', { email: `nobody-${unique()}@x.test`, password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('upgrades a password hash from before versioning at the next sign-in', async () => {
    const { email } = await registerOwner(app);
    const salt = randomBytes(16);
    const legacy = `${salt.toString('hex')}:${scryptSync(PASSWORD, salt, 64).toString('hex')}`;
    const users = prismaOf(app).user;
    await users.update({ where: { email }, data: { passwordHash: legacy } });

    expect((await new Client(app).post('/auth/login', { email, password: 'not the password at all' })).status).toBe(401);
    expect((await users.findUniqueOrThrow({ where: { email } })).passwordHash).toBe(legacy);

    expect((await new Client(app).post('/auth/login', { email, password: PASSWORD })).status).toBe(200);
    const upgraded = (await users.findUniqueOrThrow({ where: { email } })).passwordHash;
    expect(upgraded).toMatch(/^s2\$14\$8\$5\$/);
    expect((await new Client(app).post('/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('requires the session CSRF token on state-changing requests', async () => {
    const { client } = await registerOwner(app);
    const saved = client.csrf;
    client.csrf = '';
    expect((await client.post('/tenants', { firstName: 'A', lastName: 'B' })).status).toBe(403);
    client.csrf = 'forged-token-value';
    expect((await client.post('/tenants', { firstName: 'A', lastName: 'B' })).status).toBe(403);
    client.csrf = saved;
    expect((await client.post('/tenants', { firstName: 'A', lastName: 'B' })).status).toBe(201);
  });

  it('invalidates the session on logout', async () => {
    const { client } = await registerOwner(app);
    const cookie = client.cookie;
    expect((await client.post('/auth/logout')).status).toBe(204);
    const replay = new Client(app);
    replay.cookie = cookie;
    expect((await replay.get('/auth/me')).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const { client, profile } = await registerOwner(app);
    await prismaOf(app).session.updateMany({
      where: { userId: profile.user.id },
      data: { lastSeenAt: new Date(Date.now() - 24 * 3_600_000) },
    });
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('resets a forgotten password once, revoking every existing session', async () => {
    const { client, email } = await registerOwner(app);
    const unknown = await new Client(app).post('/auth/password/forgot', { email: `ghost-${unique()}@x.test` });
    const known = await new Client(app).post('/auth/password/forgot', { email });
    // No account enumeration: identical responses.
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = tokenIn(lastEmail(app, email)?.text);
    const reset = await new Client(app).post('/auth/password/reset', { token, password: 'a brand new passphrase' });
    expect(reset.status).toBe(200);
    expect((await client.get('/auth/me')).status).toBe(401);
    expect((await new Client(app).post('/auth/password/reset', { token, password: 'another new passphrase' })).status).toBe(400);
    expect((await new Client(app).post('/auth/login', { email, password: PASSWORD })).status).toBe(401);
    const login = await new Client(app).post('/auth/login', { email, password: 'a brand new passphrase' });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(true);
  });

  it('changes the password with the current one and signs out other devices', async () => {
    const { client, email } = await registerOwner(app);
    const laptop = new Client(app);
    await laptop.post('/auth/login', { email, password: PASSWORD });
    expect((await client.get('/auth/sessions')).body).toHaveLength(2);
    expect((await client.post('/auth/password', { currentPassword: 'wrong wrong wrong', newPassword: 'fresh passphrase here' })).status).toBe(422);
    expect((await client.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'fresh passphrase here' })).status).toBe(204);
    expect((await client.get('/auth/me')).status).toBe(200);
    expect((await laptop.get('/auth/me')).status).toBe(401);
  });

  it('lists sessions and revokes the others on request', async () => {
    const { client, email } = await registerOwner(app);
    const phone = new Client(app);
    await phone.post('/auth/login', { email, password: PASSWORD }, { 'user-agent': 'Phone Browser' });
    const sessions = (await client.get('/auth/sessions')).body;
    expect(sessions.filter((item: { current: boolean }) => item.current)).toHaveLength(1);
    expect((await client.post('/auth/sessions/revoke-others')).body.revoked).toBe(1);
    expect((await phone.get('/auth/me')).status).toBe(401);
  });

  it('rate-limits repeated login attempts per client', async () => {
    const previous = process.env['RATE_LIMIT_MULTIPLIER'];
    process.env['RATE_LIMIT_MULTIPLIER'] = '1';
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt++)
        statuses.push(
          (await new Client(app).post('/auth/login', { email: 'limit@rentflow.test', password: 'x' }, { 'x-forwarded-for': '203.0.113.9' })).status,
        );
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      process.env['RATE_LIMIT_MULTIPLIER'] = previous;
    }
  });

  it('still rate-limits clients that rotate invalid session cookies', async () => {
    const previous = process.env['RATE_LIMIT_MULTIPLIER'];
    process.env['RATE_LIMIT_MULTIPLIER'] = '1';
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await new Client(app).post('/auth/login', { email: 'limit@rentflow.test', password: 'x' }, {
          'x-forwarded-for': '203.0.113.121', cookie: `rentflow_session=invalid-${attempt}`,
        });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally { process.env['RATE_LIMIT_MULTIPLIER'] = previous; }
  });
});
