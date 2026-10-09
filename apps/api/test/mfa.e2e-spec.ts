import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { timeStep, totpCode } from '../src/auth/mfa.js';
import { sha256 } from '../src/common/crypto.js';
import { MailerService } from '../src/mail/mailer.service.js';
import { Client, lastEmail, PASSWORD, prismaOf, registerOwner, startApp, unique } from './helpers.js';

describe('two-step sign-in (TOTP)', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let email: string;
  let secret: string;
  let recoveryCodes: string[];
  let enableCode: string;

  /** A code for a step the server has not accepted yet (tests cannot wait 30 s). */
  const freshCode = async () => {
    await prismaOf(app).user.update({ where: { email }, data: { mfaLastStep: timeStep() - 2 } });
    return totpCode(secret, timeStep());
  };
  const signIn = async (password = PASSWORD) => {
    const client = new Client(app);
    const response = await client.post('/auth/login', { email, password });
    return { client, response };
  };

  beforeAll(async () => {
    app = await startApp();
    const registered = await registerOwner(app);
    owner = registered.client;
    email = registered.email;
  });
  afterAll(async () => app.close());

  it('turns on only after the password and a first valid code, and shows recovery codes once', async () => {
    const otherDevice = (await signIn()).client;
    expect((await owner.post('/auth/mfa/setup', { password: 'wrong password!!' })).body.code).toBe('PASSWORD_INCORRECT');

    const setup = await owner.post('/auth/mfa/setup', { password: PASSWORD });
    expect(setup.status).toBe(200);
    secret = setup.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.uri).toContain(`secret=${secret}`);
    expect(setup.body.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    // Stored encrypted, never as the plain secret.
    const stored = await prismaOf(app).user.findUniqueOrThrow({ where: { email } });
    expect(stored.mfaPendingSecret).not.toContain(secret);

    expect((await owner.post('/auth/mfa/enable', { code: '000000' })).body.code).toBe('MFA_CODE_INVALID');
    enableCode = totpCode(secret, timeStep());
    const enabled = await owner.post('/auth/mfa/enable', { code: enableCode });
    expect(enabled.status).toBe(200);
    recoveryCodes = enabled.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect((await owner.get('/auth/me')).body.user.mfaEnabled).toBe(true);
    expect((await owner.post('/auth/mfa/setup', { password: PASSWORD })).body.code).toBe('MFA_ALREADY_ENABLED');
    // Other devices that signed in with the password alone are signed out.
    expect((await otherDevice.get('/auth/me')).status).toBe(401);
    expect(lastEmail(app, email)?.subject).toBe('Two-step sign-in is on');
  });

  it('asks for a code after the password and creates no session until it is right', async () => {
    const { client, response } = await signIn();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mfaRequired: true, challenge: expect.any(String) });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await client.get('/auth/me')).status).toBe(401);

    // The code already used to turn MFA on cannot be replayed.
    const replay = await client.post('/auth/login/mfa', { challenge: response.body.challenge, code: enableCode });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('INVALID_MFA_CODE');

    const code = await freshCode();
    const done = await client.post('/auth/login/mfa', { challenge: response.body.challenge, code });
    expect(done.status).toBe(200);
    expect(done.body.user.email).toBe(email);
    expect((await client.get('/auth/me')).status).toBe(200);
    // A challenge works once.
    expect((await new Client(app).post('/auth/login/mfa', { challenge: response.body.challenge, code })).body.code).toBe('MFA_CHALLENGE_INVALID');
    // A wrong password never reaches the code step.
    expect((await signIn('not the password!!')).response.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks a challenge after five wrong codes', async () => {
    const { client, response } = await signIn();
    for (let i = 0; i < 5; i += 1)
      expect((await client.post('/auth/login/mfa', { challenge: response.body.challenge, code: '123456' })).body.code).toBe('INVALID_MFA_CODE');
    const right = await client.post('/auth/login/mfa', { challenge: response.body.challenge, code: await freshCode() });
    expect(right.body.code).toBe('MFA_CHALLENGE_INVALID');
  });

  it('accepts each recovery code once and tells the owner', async () => {
    const first = await signIn();
    const failure = vi.spyOn(app.get(MailerService), 'enqueue').mockRejectedValueOnce(new Error('queue unavailable'));
    try {
      expect((await first.client.post('/auth/login/mfa', { challenge: first.response.body.challenge, code: recoveryCodes[0] })).status).toBe(500);
      expect(await prismaOf(app).mfaRecoveryCode.count({ where: { user: { email }, usedAt: null } })).toBe(10);
    } finally { failure.mockRestore(); }
    const used = await first.client.post('/auth/login/mfa', { challenge: first.response.body.challenge, code: recoveryCodes[0]!.toUpperCase() });
    expect(used.status).toBe(200);
    expect(lastEmail(app, email)?.text).toContain('You have 9 left');

    const second = await signIn();
    expect((await second.client.post('/auth/login/mfa', { challenge: second.response.body.challenge, code: recoveryCodes[0] })).body.code).toBe('INVALID_MFA_CODE');
  });

  it('counts wrong codes against the account across challenges, then refuses sign-in', async () => {
    const failures = { emailHash: sha256(email) };
    await prismaOf(app).loginFailure.deleteMany({ where: failures });
    try {
      for (let round = 0; round < 2; round += 1) {
        const { client, response } = await signIn();
        for (let i = 0; i < 5; i += 1)
          expect((await client.post('/auth/login/mfa', { challenge: response.body.challenge, code: '123456' })).body.code).toBe('INVALID_MFA_CODE');
      }
      expect((await signIn()).response.body.code).toBe('INVALID_CREDENTIALS');
    } finally {
      await prismaOf(app).loginFailure.deleteMany({ where: failures });
    }
  });

  it('replaces recovery codes and turns off only with the password and a code', async () => {
    const replaced = await owner.post('/auth/mfa/recovery-codes', { password: PASSWORD, code: await freshCode() });
    expect(replaced.status).toBe(200);
    const old = await signIn();
    expect((await old.client.post('/auth/login/mfa', { challenge: old.response.body.challenge, code: recoveryCodes[1] })).body.code).toBe('INVALID_MFA_CODE');
    recoveryCodes = replaced.body.recoveryCodes;

    expect((await owner.post('/auth/mfa/disable', { password: PASSWORD, code: '000000' })).body.code).toBe('MFA_CODE_INVALID');
    expect((await owner.post('/auth/mfa/disable', { password: 'wrong password!!', code: recoveryCodes[0] })).body.code).toBe('PASSWORD_INCORRECT');
    expect((await owner.post('/auth/mfa/disable', { password: PASSWORD, code: recoveryCodes[0] })).status).toBe(204);
    expect(await prismaOf(app).mfaRecoveryCode.count({ where: { user: { email } } })).toBe(0);
    expect(lastEmail(app, email)?.subject).toBe('Two-step sign-in is off');

    const plain = await signIn();
    expect(plain.response.body.user.email).toBe(email);
    expect(plain.response.headers['set-cookie']).toBeDefined();
  });

  describe('required for owners of a workspace', () => {
    /** Registers without the test helper, so the new-workspace default (required) applies. */
    const strictOwner = async () => {
      const client = new Client(app);
      const ownerEmail = `strict-${unique()}@rentflow.test`;
      const registered = await client.post('/auth/register', { email: ownerEmail, password: PASSWORD, name: 'Strict Owner', organizationName: `Strict ${unique()}` });
      expect(registered.status).toBe(201);
      return { client, ownerEmail, registered: registered.body };
    };
    const turnOn = async (client: Client) => {
      const setup = await client.post('/auth/mfa/setup', { password: PASSWORD });
      expect((await client.post('/auth/mfa/enable', { code: totpCode(setup.body.secret, timeStep()) })).status).toBe(200);
      return setup.body.secret as string;
    };

    it('blocks everything but account routes until the owner turns it on', async () => {
      const { client, registered } = await strictOwner();
      expect(registered).toMatchObject({ role: 'OWNER', mfaSetupRequired: true, organization: { requireOwnerMfa: true } });
      for (const response of [await client.get('/dashboard'), await client.post('/tenants', { firstName: 'A', lastName: 'B' })]) {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('MFA_SETUP_REQUIRED');
      }
      expect((await client.get('/auth/me')).status).toBe(200);
      expect((await client.get('/auth/sessions')).status).toBe(200);

      await turnOn(client);
      expect((await client.get('/auth/me')).body.mfaSetupRequired).toBe(false);
      expect((await client.get('/dashboard')).status).toBe(200);
    });

    it('does not apply to other roles, and changes only with the password and a code', async () => {
      const { client, ownerEmail } = await strictOwner();
      const secret = await turnOn(client);
      const staffEmail = `manager-${unique()}@rentflow.test`;
      const invite = await client.post('/staff/invitations', { email: staffEmail, role: 'MANAGER' });
      await new Client(app).post('/staff/invitations/accept', { token: invite.body.token, name: 'Manager', password: PASSWORD });
      const manager = new Client(app);
      expect((await manager.post('/auth/login', { email: staffEmail, password: PASSWORD })).body.mfaSetupRequired).toBe(false);
      expect((await manager.get('/dashboard')).status).toBe(200);
      expect((await manager.post('/auth/mfa/owner-requirement', { required: false, password: PASSWORD, code: '000000' })).status).toBe(403);

      expect((await client.post('/auth/mfa/owner-requirement', { required: false, password: PASSWORD, code: '000000' })).body.code).toBe('MFA_CODE_INVALID');
      expect((await client.post('/auth/mfa/owner-requirement', { required: false, password: 'wrong password!!', code: '000000' })).body.code).toBe('PASSWORD_INCORRECT');
      await prismaOf(app).user.update({ where: { email: ownerEmail }, data: { mfaLastStep: timeStep() - 2 } });
      const off = await client.post('/auth/mfa/owner-requirement', { required: false, password: PASSWORD, code: totpCode(secret, timeStep()) });
      expect(off.body).toEqual({ requireOwnerMfa: false });
      expect((await client.get('/auth/me')).body.organization.requireOwnerMfa).toBe(false);
      expect(await prismaOf(app).auditLog.count({ where: { action: 'OWNER_MFA_NOT_REQUIRED' } })).toBeGreaterThan(0);
    });
  });
});
