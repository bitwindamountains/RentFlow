import { Injectable } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';
import { audit } from '../common/audit.js';
import { assertPasswordPolicy, hashPassword, randomToken, sha256, verifyPassword } from '../common/crypto.js';
import { DomainError, notFound } from '../common/errors.js';
import { PrismaService } from '../common/prisma.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { normalizeEmail } from '../auth/auth.service.js';

const invitationLifetime = 7 * 86_400_000;

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  async list(organizationId: string) {
    const [members, invitations] = await Promise.all([
      this.prisma.membership.findMany({
        where: { organizationId, status: { not: 'REVOKED' } },
        include: { user: { select: { id: true, displayName: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.staffInvitation.findMany({
        where: { organizationId, status: 'PENDING', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      members: members.map((member) => ({
        id: member.id,
        userId: member.userId,
        name: member.user.displayName,
        email: member.user.email,
        role: member.role,
        status: member.status,
        joinedAt: member.joinedAt?.toISOString() ?? null,
      })),
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
      })),
    };
  }

  async invite(organizationId: string, actorUserId: string, input: { email: string; role: MembershipRole }) {
    if (input.role === 'OWNER') throw new DomainError('INVALID_ROLE', 422);
    const email = normalizeEmail(input.email);
    const token = randomToken(32);
    const invitation = await this.prisma.$transaction(async (tx) => {
      const member = await tx.membership.findFirst({
        where: { organizationId, user: { email }, status: { in: ['ACTIVE', 'SUSPENDED', 'INVITED'] } },
      });
      if (member) throw new DomainError('ALREADY_A_MEMBER', 409);
      // A new invitation replaces any earlier pending one for the same email.
      await tx.staffInvitation.updateMany({
        where: { organizationId, email, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      const created = await tx.staffInvitation.create({
        data: {
          organizationId,
          email,
          role: input.role,
          tokenHash: sha256(token),
          invitedBy: actorUserId,
          expiresAt: new Date(Date.now() + invitationLifetime),
        },
        include: { organization: { select: { name: true } } },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'STAFF_INVITED',
        entityType: 'StaffInvitation',
        entityId: created.id,
        after: { role: input.role },
      });
      return created;
    });
    const link = this.mailer.link('/accept-invite', { token });
    this.mailer.sendInBackground(
      {
        to: email,
        subject: `You're invited to ${invitation.organization.name} on RentFlow`,
        text: [
          `You have been invited to join ${invitation.organization.name} on RentFlow as ${invitation.role.toLowerCase()}.`,
          '',
          'Accept the invitation (valid for 7 days):',
          link,
        ].join('\n'),
      },
      'STAFF_INVITATION',
    );
    return {
      id: invitation.id,
      email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      // Returned once so the owner can also share it directly (e.g. by chat).
      link,
      token,
    };
  }

  async revokeInvitation(organizationId: string, actorUserId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.staffInvitation.updateMany({
        where: { id, organizationId, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      if (!updated.count) throw notFound();
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'STAFF_INVITATION_REVOKED',
        entityType: 'StaffInvitation',
        entityId: id,
      });
      return { revoked: true };
    });
  }

  /**
   * Changes a member's role or status. Suspension and removal revoke all of
   * that member's sessions in this workspace immediately.
   */
  async updateMember(
    organizationId: string,
    actorUserId: string,
    membershipId: string,
    input: { role?: MembershipRole; status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' },
  ) {
    if (input.role === 'OWNER') throw new DomainError('INVALID_ROLE', 422);
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.membership.findFirst({ where: { id: membershipId, organizationId } });
      if (!member || member.status === 'REVOKED') throw notFound('MEMBER_NOT_FOUND');
      if (member.userId === actorUserId) throw new DomainError('SELF_CHANGE_NOT_ALLOWED', 422);
      if (member.role === 'OWNER') throw new DomainError('OWNER_PROTECTED', 422);
      const updated = await tx.membership.update({
        where: { id: member.id },
        data: { ...(input.role ? { role: input.role } : {}), ...(input.status ? { status: input.status } : {}) },
      });
      if (input.status && input.status !== 'ACTIVE')
        await tx.session.updateMany({
          where: { userId: member.userId, organizationId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: input.status === 'REVOKED' ? 'STAFF_REMOVED' : 'STAFF_UPDATED',
        entityType: 'Membership',
        entityId: member.id,
        before: { role: member.role, status: member.status },
        after: { role: updated.role, status: updated.status },
      });
      return { id: updated.id, role: updated.role, status: updated.status };
    });
  }

  async acceptInvitation(input: { token: string; name?: string; password: string }) {
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash: sha256(input.token) },
      include: { organization: { select: { slug: true, status: true } } },
    });
    if (
      !invitation ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt <= new Date() ||
      invitation.organization.status !== 'ACTIVE'
    )
      throw new DomainError('INVITATION_INVALID', 400);
    const existing = await this.prisma.user.findUnique({ where: { email: invitation.email } });
    if (existing) {
      if (existing.disabledAt || !(await verifyPassword(input.password, existing.passwordHash)))
        throw new DomainError(
          'INVALID_CREDENTIALS',
          401,
          'Use your existing RentFlow password, or reset it with “Forgot password”.',
        );
    } else {
      if (!input.name?.trim() || input.name.trim().length < 2)
        throw new DomainError('NAME_AND_STRONG_PASSWORD_REQUIRED', 422);
      assertPasswordPolicy(input.password, invitation.email);
    }
    const passwordHash = existing ? undefined : await hashPassword(input.password);
    const user = await this.prisma.serializable(async (tx) => {
      const claimed = await tx.staffInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new DomainError('INVITATION_INVALID', 400);
      const account =
        existing ??
        (await tx.user.create({
          data: { email: invitation.email, displayName: input.name!.trim(), passwordHash: passwordHash! },
        }));
      const member = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId: account.id } },
      });
      // Never silently change an active or suspended member; a removed member may be re-invited.
      if (member && member.status !== 'REVOKED') throw new DomainError('ALREADY_A_MEMBER', 409);
      if (member)
        await tx.membership.update({
          where: { id: member.id },
          data: { role: invitation.role, status: 'ACTIVE', joinedAt: new Date() },
        });
      else
        await tx.membership.create({
          data: {
            organizationId: invitation.organizationId,
            userId: account.id,
            role: invitation.role,
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        });
      await audit(tx, {
        organizationId: invitation.organizationId,
        actorUserId: account.id,
        action: 'STAFF_INVITATION_ACCEPTED',
        entityType: 'StaffInvitation',
        entityId: invitation.id,
      });
      return account;
    });
    return { accepted: true, email: user.email, workspace: invitation.organization.slug };
  }
}
