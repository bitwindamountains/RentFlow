import { Injectable } from '@nestjs/common';
import type { MembershipRole, User, UserTokenType } from '@prisma/client';
import QRCode from 'qrcode';
import { audit } from '../common/audit.js';
import {
  assertPasswordPolicy,
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../common/crypto.js';
import { DomainError } from '../common/errors.js';
import { isUniqueViolation, PrismaService, type Tx } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';
import { MailerService } from '../mail/mailer.service.js';
import {
  assertMfaAvailable,
  decryptSecret,
  encryptSecret,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryCodeHash,
  verifyTotp,
} from './mfa.js';
import type { SessionContext } from './session.types.js';

const touchInterval = 5 * 60 * 1000;
const resetLifetime = 30 * 60 * 1000;
const verificationLifetime = 48 * 60 * 60 * 1000;
const mfaChallengeLifetime = 5 * 60 * 1000;
const mfaChallengeAttempts = 5;

export interface IssuedSession {
  token: string;
  context: SessionContext;
}

/** The password was right; a second factor is needed before a session exists. */
export interface MfaChallenge {
  mfaRequired: true;
  challenge: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
    userAgent?: string;
  }): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    assertPasswordPolicy(input.password, email);
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } }))
      throw new DomainError('EMAIL_EXISTS', 409);
    const passwordHash = await hashPassword(input.password);
    try {
      const issued = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, displayName: input.name.trim(), passwordHash },
        });
        const slug = await uniqueSlug(tx, input.organizationName);
        const organization = await tx.organization.create({
          data: {
            name: input.organizationName.trim(),
            slug,
            receiptPrefix: slug.replace(/-/g, '').toUpperCase().slice(0, 4) || 'RF',
            receiptSequence: { create: {} },
          },
        });
        await tx.membership.create({
          data: {
            userId: user.id,
            organizationId: organization.id,
            role: 'OWNER',
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        });
        await audit(tx, {
          organizationId: organization.id,
          actorUserId: user.id,
          action: 'ORGANIZATION_REGISTERED',
          entityType: 'Organization',
          entityId: organization.id,
        });
        await this.sendVerification(tx, user.id, email);
        return this.createSession(tx, user.id, organization.id, { role: 'OWNER', tenantId: null }, false, input.userAgent);
      });
      this.mailer.kick();
      return issued;
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('EMAIL_EXISTS', 409);
      throw error;
    }
  }

  async login(input: {
    email: string;
    password: string;
    workspace?: string;
    userAgent?: string;
  }): Promise<IssuedSession | MfaChallenge> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(input.email) },
    });
    // Always run scrypt so the response time does not reveal registered emails.
    const valid = await verifyPassword(input.password, user?.passwordHash);
    if (!user || !valid || user.disabledAt) throw new DomainError('INVALID_CREDENTIALS', 401);
    const membership = await this.loginMembership(user.id, input.workspace);
    if (!membership) throw new DomainError('INVALID_CREDENTIALS', 401);
    if (user.mfaEnabledAt)
      return { mfaRequired: true, challenge: await this.issueToken(user.id, 'MFA_CHALLENGE', mfaChallengeLifetime) };
    return this.prisma.$transaction((tx) =>
      this.createSession(
        tx,
        user.id,
        membership.organizationId,
        membership,
        Boolean(user.emailVerifiedAt),
        input.userAgent,
      ),
    );
  }

  /**
   * Second sign-in step: a code from the authenticator app (or a one-time
   * recovery code) against the challenge issued after the password. A
   * challenge allows a few wrong codes, then the person must sign in again.
   */
  async completeMfaLogin(input: { challenge: string; code: string; workspace?: string; userAgent?: string }): Promise<IssuedSession> {
    const record = await this.prisma.userToken.findUnique({ where: { tokenHash: sha256(input.challenge) } });
    if (!record || record.type !== 'MFA_CHALLENGE' || record.usedAt || record.expiresAt <= new Date() || record.attempts >= mfaChallengeAttempts)
      throw new DomainError('MFA_CHALLENGE_INVALID', 401);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    if (user.disabledAt || !user.mfaEnabledAt) throw new DomainError('MFA_CHALLENGE_INVALID', 401);
    const factor = await this.checkSecondFactor(user, input.code);
    if (!factor) {
      await this.prisma.userToken.updateMany({ where: { id: record.id, attempts: { lt: mfaChallengeAttempts } }, data: { attempts: { increment: 1 } } });
      throw new DomainError('INVALID_MFA_CODE', 401);
    }
    const claimed = await this.prisma.userToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new DomainError('MFA_CHALLENGE_INVALID', 401);
    const membership = await this.loginMembership(user.id, input.workspace);
    if (!membership) throw new DomainError('INVALID_CREDENTIALS', 401);
    if (factor === 'recovery') await this.noticeRecoveryCodeUsed(user, membership.organizationId);
    return this.prisma.$transaction((tx) =>
      this.createSession(tx, user.id, membership.organizationId, membership, Boolean(user.emailVerifiedAt), input.userAgent),
    );
  }

  // ------------------------------------------------------------ two-step setup
  /** Step 1: a new secret (pending until confirmed), shown as a QR code and as text. */
  async startMfaSetup(context: SessionContext, password: string) {
    assertMfaAvailable();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: context.userId } });
    if (!(await verifyPassword(password, user.passwordHash))) throw new DomainError('PASSWORD_INCORRECT', 422);
    if (user.mfaEnabledAt) throw new DomainError('MFA_ALREADY_ENABLED', 409);
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaPendingSecret: encryptSecret(secret) } });
    const uri = otpauthUri(secret, user.email);
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  }

  /** Step 2: the first code proves the app is set up; MFA turns on and recovery codes are shown once. */
  async enableMfa(context: SessionContext, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: context.userId } });
    if (user.mfaEnabledAt) throw new DomainError('MFA_ALREADY_ENABLED', 409);
    if (!user.mfaPendingSecret) throw new DomainError('MFA_SETUP_REQUIRED', 409);
    const step = verifyTotp(decryptSecret(user.mfaPendingSecret), code, null);
    if (step === null) throw new DomainError('MFA_CODE_INVALID', 422);
    const recoveryCodes = newRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { mfaSecret: user.mfaPendingSecret, mfaPendingSecret: null, mfaEnabledAt: new Date(), mfaLastStep: step },
      });
      await this.replaceRecoveryCodes(tx, user.id, recoveryCodes);
      // Other devices signed in with the password alone are signed out.
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: context.sessionId } }, data: { revokedAt: new Date() } });
      await audit(tx, { organizationId: context.organizationId, actorUserId: user.id, action: 'MFA_ENABLED', entityType: 'User', entityId: user.id });
      await this.mailer.enqueue(tx, { to: user.email, subject: 'Two-step sign-in is on', text: 'Two-step sign-in was turned on for your RentFlow account. You will be asked for a code from your authenticator app when you sign in.' }, 'SECURITY_NOTICE', { userId: user.id, organizationId: context.organizationId });
    });
    this.mailer.kick();
    return { recoveryCodes };
  }

  async disableMfa(context: SessionContext, password: string, code: string): Promise<void> {
    const user = await this.verifiedForMfaChange(context, password, code);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await audit(tx, { organizationId: context.organizationId, actorUserId: user.id, action: 'MFA_DISABLED', entityType: 'User', entityId: user.id });
      await this.mailer.enqueue(tx, { to: user.email, subject: 'Two-step sign-in is off', text: 'Two-step sign-in was turned off for your RentFlow account. If this was not you, reset your password now and turn it back on.' }, 'SECURITY_NOTICE', { userId: user.id, organizationId: context.organizationId });
    });
    this.mailer.kick();
  }

  async regenerateRecoveryCodes(context: SessionContext, password: string, code: string) {
    const user = await this.verifiedForMfaChange(context, password, code);
    const recoveryCodes = newRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await this.replaceRecoveryCodes(tx, user.id, recoveryCodes);
      await audit(tx, { organizationId: context.organizationId, actorUserId: user.id, action: 'MFA_RECOVERY_CODES_REPLACED', entityType: 'User', entityId: user.id });
    });
    return { recoveryCodes };
  }

  private async verifiedForMfaChange(context: SessionContext, password: string, code: string): Promise<User> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: context.userId } });
    if (!(await verifyPassword(password, user.passwordHash))) throw new DomainError('PASSWORD_INCORRECT', 422);
    if (!user.mfaEnabledAt) throw new DomainError('MFA_NOT_ENABLED', 409);
    if (!(await this.checkSecondFactor(user, code))) throw new DomainError('MFA_CODE_INVALID', 422);
    return user;
  }

  /**
   * Accepts a current authenticator code (each time step at most once) or an
   * unused recovery code (consumed). Returns which kind matched.
   */
  private async checkSecondFactor(user: User, code: string): Promise<'totp' | 'recovery' | null> {
    if (!user.mfaSecret) return null;
    if (looksLikeRecoveryCode(code)) {
      return this.prisma.$transaction(async tx => {
        const used = await tx.mfaRecoveryCode.updateMany({
          where: { userId: user.id, codeHash: recoveryCodeHash(code), usedAt: null },
          data: { usedAt: new Date() },
        });
        if (used.count !== 1) return null;
        const left = await tx.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } });
        await this.mailer.enqueue(tx, {
          to: user.email,
          subject: 'A recovery code was used to sign in',
          text: `A recovery code was used for your RentFlow account. You have ${left} left. If this was not you, reset your password and create new recovery codes on the Account page.`,
        }, 'SECURITY_NOTICE', { userId: user.id });
        return 'recovery' as const;
      });
    }
    const step = verifyTotp(decryptSecret(user.mfaSecret), code, user.mfaLastStep);
    if (step === null) return null;
    // Conditional update: two requests with the same code cannot both pass.
    const claimed = await this.prisma.user.updateMany({
      where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    return claimed.count === 1 ? 'totp' : null;
  }

  private async replaceRecoveryCodes(tx: Tx, userId: string, codes: string[]): Promise<void> {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: recoveryCodeHash(code) })) });
  }

  private async noticeRecoveryCodeUsed(user: User, organizationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await audit(tx, { organizationId, actorUserId: user.id, action: 'MFA_RECOVERY_CODE_USED', entityType: 'User', entityId: user.id });
    });
    this.mailer.kick();
  }

  /** The workspace a sign-in lands in: the named one, or the oldest active membership. */
  private loginMembership(userId: string, workspaceInput?: string) {
    const workspace = workspaceInput?.trim().toLowerCase();
    return this.prisma.membership.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        organization: { status: 'ACTIVE', ...(workspace ? { slug: workspace } : {}) },
        // Archived tenants cannot sign in to the portal.
        OR: [{ tenantId: null }, { tenant: { status: { not: 'ARCHIVED' } } }],
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Resolves a bearer token to a live session. Role, membership status, user
   * status, and organization status are re-read on every request so that
   * revocations take effect immediately.
   */
  async resolveSession(token?: string, userAgent?: string): Promise<SessionContext | undefined> {
    if (!token || token.length > 200) return undefined;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { disabledAt: true, emailVerifiedAt: true } } },
    });
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now) return undefined;
    const idleLimit = environment().SESSION_IDLE_MINUTES * 60 * 1000;
    if (now - session.lastSeenAt.getTime() > idleLimit) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return undefined;
    }
    if (session.user.disabledAt) return undefined;
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: session.userId,
        organizationId: session.organizationId,
        status: 'ACTIVE',
        organization: { status: 'ACTIVE' },
      },
      select: { role: true, tenantId: true, tenant: { select: { status: true } } },
    });
    if (!membership) return undefined;
    // An archived tenant loses portal access immediately.
    if (membership.role === 'TENANT' && (!membership.tenantId || membership.tenant?.status === 'ARCHIVED')) return undefined;
    if (now - session.lastSeenAt.getTime() > touchInterval)
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}) },
      });
    return {
      sessionId: session.id,
      csrfToken: session.csrfToken,
      userId: session.userId,
      organizationId: session.organizationId,
      role: membership.role,
      tenantId: membership.role === 'TENANT' ? membership.tenantId : null,
      expiresAt: session.expiresAt,
      emailVerified: Boolean(session.user.emailVerifiedAt),
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async profile(context: SessionContext) {
    const membership = await this.prisma.membership.findUnique({
      where: {
        organizationId_userId: { organizationId: context.organizationId, userId: context.userId },
      },
      include: { user: true, organization: true },
    });
    if (!membership || membership.status !== 'ACTIVE')
      throw new DomainError('UNAUTHENTICATED', 401, 'Authentication required');
    const workspaces = await this.prisma.membership.findMany({
      where: { userId: context.userId, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
      select: { role: true, organization: { select: { name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      user: {
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.displayName,
        emailVerified: Boolean(membership.user.emailVerifiedAt),
        mfaEnabled: Boolean(membership.user.mfaEnabledAt),
      },
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        currency: membership.organization.currency,
        timezone: membership.organization.timezone,
      },
      role: membership.role,
      csrfToken: context.csrfToken,
      sessionExpiresAt: context.expiresAt.toISOString(),
      workspaces: workspaces.map((item) => ({ ...item.organization, role: item.role })),
    };
  }

  async switchWorkspace(context: SessionContext, slug: string, userAgent?: string): Promise<IssuedSession> {
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: context.userId,
        status: 'ACTIVE',
        organization: { slug: slug.trim().toLowerCase(), status: 'ACTIVE' },
        OR: [{ tenantId: null }, { tenant: { status: { not: 'ARCHIVED' } } }],
      },
    });
    if (!membership) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { id: context.sessionId }, data: { revokedAt: new Date() } });
      return this.createSession(
        tx,
        context.userId,
        membership.organizationId,
        membership,
        context.emailVerified,
        userAgent,
      );
    });
  }

  /** Always succeeds from the caller's perspective to avoid account enumeration. */
  async requestPasswordReset(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.disabledAt) return;
    await this.prisma.$transaction(async (tx) => {
      const { token, record } = await this.createToken(tx, user.id, 'PASSWORD_RESET', resetLifetime);
      await this.mailer.enqueue(tx,
        {
          to: email,
          subject: 'Reset your RentFlow password',
          text: [
            `Hi ${user.displayName},`,
            '',
            'Use this link to choose a new RentFlow password. It expires in 30 minutes and works once:',
            this.mailer.link('/reset-password', { token }),
            '',
            'If you did not ask for this, ignore this email. Your password has not changed.',
          ].join('\n'),
        },
        'PASSWORD_RESET',
        { userId: user.id, tokenId: record.id, expiresAt: record.expiresAt },
      );
    });
    this.mailer.kick();
  }

  async resetPassword(token: string, password: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const record = await this.consumeToken(tx, token, 'PASSWORD_RESET');
      const user = await tx.user.findUniqueOrThrow({ where: { id: record.userId } });
      assertPasswordPolicy(password, user.email);
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(password),
          // Receiving the reset email proves control of the address.
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.userToken.updateMany({
        where: { userId: user.id, type: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: new Date() },
      });
    });
  }

  async verifyEmail(token: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const record = await this.consumeToken(tx, token, 'EMAIL_VERIFICATION');
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      });
    });
  }

  async resendVerification(context: SessionContext): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: context.userId } });
    if (!user.emailVerifiedAt) {
      await this.prisma.$transaction(tx => this.sendVerification(tx, user.id, user.email));
      this.mailer.kick();
    }
  }

  async changePassword(context: SessionContext, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: context.userId } });
    if (!(await verifyPassword(current, user.passwordHash)))
      throw new DomainError('PASSWORD_INCORRECT', 422);
    assertPasswordPolicy(next, user.email);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(next) },
      }),
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: context.sessionId } },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  async listSessions(context: SessionContext) {
    const sessions = await this.prisma.session.findMany({
      where: { userId: context.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { organization: { select: { name: true } } },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
    });
    return sessions.map((session) => ({
      id: session.id,
      workspace: session.organization.name,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      current: session.id === context.sessionId,
    }));
  }

  async revokeSession(context: SessionContext, sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, userId: context.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeOtherSessions(context: SessionContext): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId: context.userId, revokedAt: null, id: { not: context.sessionId } },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  private async createSession(
    tx: Tx,
    userId: string,
    organizationId: string,
    membership: { role: MembershipRole; tenantId: string | null },
    emailVerified: boolean,
    userAgent?: string,
  ): Promise<IssuedSession> {
    const { role } = membership;
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + environment().SESSION_ABSOLUTE_HOURS * 3_600_000);
    const session = await tx.session.create({
      data: {
        tokenHash: sha256(token),
        csrfToken,
        userId,
        organizationId,
        role,
        expiresAt,
        userAgent: userAgent?.slice(0, 300),
      },
    });
    return {
      token,
      context: {
        sessionId: session.id,
        csrfToken,
        userId,
        organizationId,
        role,
        tenantId: role === 'TENANT' ? membership.tenantId : null,
        expiresAt,
        emailVerified,
      },
    };
  }

  private async issueToken(userId: string, type: UserTokenType, lifetime: number): Promise<string> {
    return (await this.prisma.$transaction(tx => this.createToken(tx, userId, type, lifetime))).token;
  }

  private async createToken(tx: Tx, userId: string, type: UserTokenType, lifetime: number) {
    const token = randomToken(32);
    await tx.userToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    });
    const record = await tx.userToken.create({
      data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + lifetime) },
    });
    return { token, record };
  }

  private async consumeToken(tx: Tx, token: string, type: UserTokenType) {
    const record = await tx.userToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.type !== type || record.usedAt || record.expiresAt <= new Date())
      throw new DomainError('TOKEN_INVALID', 400);
    const claimed = await tx.userToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw new DomainError('TOKEN_INVALID', 400);
    return record;
  }

  private async sendVerification(tx: Tx, userId: string, email: string): Promise<void> {
    const { token, record } = await this.createToken(tx, userId, 'EMAIL_VERIFICATION', verificationLifetime);
    await this.mailer.enqueue(tx,
      {
        to: email,
        subject: 'Confirm your RentFlow email',
        text: [
          'Confirm your email address to keep your RentFlow account recoverable:',
          this.mailer.link('/verify-email', { token }),
          '',
          'This link expires in 48 hours.',
        ].join('\n'),
      },
      'EMAIL_VERIFICATION',
      { userId, tokenId: record.id, expiresAt: record.expiresAt },
    );
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'workspace';
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (!(await tx.organization.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}
