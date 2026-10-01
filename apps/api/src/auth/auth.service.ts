import { Injectable } from '@nestjs/common';
import type { MembershipRole, UserTokenType } from '@prisma/client';
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
import type { SessionContext } from './session.types.js';

const touchInterval = 5 * 60 * 1000;
const resetLifetime = 30 * 60 * 1000;
const verificationLifetime = 48 * 60 * 60 * 1000;

export interface IssuedSession {
  token: string;
  context: SessionContext;
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
        return this.createSession(tx, user.id, organization.id, { role: 'OWNER', tenantId: null }, false, input.userAgent);
      });
      await this.sendVerification(issued.context.userId, email);
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
  }): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(input.email) },
    });
    // Always run scrypt so the response time does not reveal registered emails.
    const valid = await verifyPassword(input.password, user?.passwordHash);
    if (!user || !valid || user.disabledAt) throw new DomainError('INVALID_CREDENTIALS', 401);
    const workspace = input.workspace?.trim().toLowerCase();
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: user.id,
        status: 'ACTIVE',
        organization: { status: 'ACTIVE', ...(workspace ? { slug: workspace } : {}) },
        // Archived tenants cannot sign in to the portal.
        OR: [{ tenantId: null }, { tenant: { status: { not: 'ARCHIVED' } } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new DomainError('INVALID_CREDENTIALS', 401);
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
    const token = await this.issueToken(user.id, 'PASSWORD_RESET', resetLifetime);
    this.mailer.sendInBackground(
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
    );
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
    if (!user.emailVerifiedAt) await this.sendVerification(user.id, user.email);
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
    const token = randomToken(32);
    await this.prisma.$transaction([
      this.prisma.userToken.updateMany({
        where: { userId, type, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.userToken.create({
        data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + lifetime) },
      }),
    ]);
    return token;
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

  private async sendVerification(userId: string, email: string): Promise<void> {
    const token = await this.issueToken(userId, 'EMAIL_VERIFICATION', verificationLifetime);
    this.mailer.sendInBackground(
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
