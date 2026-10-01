import { Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import { normalizeEmail } from '../auth/auth.service.js';
import { BalancesService } from '../billing/balances.service.js';
import { audit } from '../common/audit.js';
import { randomToken, sha256 } from '../common/crypto.js';
import { formatDateOnly } from '../common/dates.js';
import { DomainError, notFound } from '../common/errors.js';
import { formatMoney, parseMoney, ZERO } from '../common/money.js';
import { PrismaService } from '../common/prisma.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { noticeView } from './portal.service.js';

const invitationLifetime = 7 * 86_400_000;

/** Staff-side management of tenant portal access and of tenants' payment notices. */
@Injectable()
export class PortalAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
    private readonly payments: PaymentsService,
    private readonly mailer: MailerService,
  ) {}

  // ------------------------------------------------------------- portal access
  async access(organizationId: string, tenantId: string) {
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, organizationId }, select: { email: true } });
    if (!tenant) throw notFound();
    const [membership, invitation] = await Promise.all([
      this.prisma.membership.findFirst({
        where: { organizationId, tenantId, role: 'TENANT', status: { not: 'REVOKED' } },
        include: { user: { select: { email: true } } },
      }),
      this.prisma.staffInvitation.findFirst({
        where: { organizationId, tenantId, role: 'TENANT', status: 'PENDING', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (membership)
      return {
        status: membership.status === 'ACTIVE' ? ('ACTIVE' as const) : ('SUSPENDED' as const),
        email: membership.user.email,
        since: membership.joinedAt?.toISOString() ?? null,
      };
    if (invitation)
      return {
        status: 'INVITED' as const,
        email: invitation.email,
        since: invitation.createdAt.toISOString(),
        expiresAt: invitation.expiresAt.toISOString(),
      };
    return { status: 'NONE' as const, email: tenant.email, since: null };
  }

  async invite(organizationId: string, actorUserId: string, tenantId: string, emailInput?: string) {
    const token = randomToken(32);
    const invitation = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, organizationId },
        include: { organization: { select: { name: true } } },
      });
      if (!tenant) throw notFound();
      if (tenant.status === 'ARCHIVED') throw new DomainError('TENANT_ARCHIVED', 422);
      const raw = emailInput ?? tenant.email;
      if (!raw) throw new DomainError('PORTAL_EMAIL_REQUIRED', 422);
      const email = normalizeEmail(raw);
      const active = await tx.membership.findFirst({
        where: { organizationId, OR: [{ tenantId }, { user: { email } }], status: { not: 'REVOKED' } },
      });
      if (active) throw new DomainError('ALREADY_A_MEMBER', 409);
      // A new invitation replaces any earlier pending one for this tenant.
      await tx.staffInvitation.updateMany({
        where: { organizationId, tenantId, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      const created = await tx.staffInvitation.create({
        data: {
          organizationId,
          email,
          role: 'TENANT',
          tenantId,
          tokenHash: sha256(token),
          invitedBy: actorUserId,
          expiresAt: new Date(Date.now() + invitationLifetime),
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'PORTAL_INVITED',
        entityType: 'Tenant',
        entityId: tenantId,
      });
      return { ...created, organizationName: tenant.organization.name, firstName: tenant.firstName };
    });
    const link = this.mailer.link('/accept-invite', { token, for: 'tenant' });
    this.mailer.sendInBackground(
      {
        to: invitation.email,
        subject: `Your tenant portal for ${invitation.organizationName}`,
        text: [
          `Hi ${invitation.firstName},`,
          '',
          `${invitation.organizationName} invited you to the RentFlow tenant portal. You can see what you owe, download receipts, tell them about payments, and report repairs.`,
          '',
          'Set up your account (link valid for 7 days):',
          link,
        ].join('\n'),
      },
      'PORTAL_INVITATION',
    );
    // Returned once so staff can also send it by SMS or Messenger.
    return { status: 'INVITED' as const, email: invitation.email, expiresAt: invitation.expiresAt.toISOString(), link };
  }

  /** Ends portal access immediately: pending invitations, the membership, and all of its sessions. */
  async revoke(organizationId: string, actorUserId: string, tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, organizationId }, select: { id: true } });
      if (!tenant) throw notFound();
      await tx.staffInvitation.updateMany({ where: { organizationId, tenantId, status: 'PENDING' }, data: { status: 'REVOKED' } });
      const members = await tx.membership.findMany({ where: { organizationId, tenantId, status: { not: 'REVOKED' } } });
      for (const member of members) {
        await tx.membership.update({ where: { id: member.id }, data: { status: 'REVOKED' } });
        await tx.session.updateMany({
          where: { userId: member.userId, organizationId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await audit(tx, { organizationId, actorUserId, action: 'PORTAL_REVOKED', entityType: 'Tenant', entityId: tenantId });
      return { status: 'NONE' as const };
    });
  }

  // ----------------------------------------------------------- payment notices
  async listNotices(organizationId: string, status: 'SUBMITTED' | 'all' = 'SUBMITTED') {
    const notices = await this.prisma.paymentNotice.findMany({
      where: { organizationId, ...(status === 'all' ? {} : { status }) },
      include: {
        payment: { include: { receipts: { orderBy: { issuedAt: 'desc' }, take: 1 } } },
        tenant: { select: { firstName: true, lastName: true } },
        lease: { select: { rentableSpace: { select: { unit: { select: { number: true, property: { select: { name: true } } } } } } } },
      },
      orderBy: { createdAt: status === 'all' ? 'desc' : 'asc' },
      take: 200,
    });
    const proofs = await this.prisma.documentRecord.findMany({
      where: { organizationId, entityType: 'PaymentNotice', entityId: { in: notices.map((n) => n.id) }, deletedAt: null },
      select: { id: true, entityId: true, contentType: true },
    });
    const outstanding = await this.balances.leaseOutstanding(organizationId);
    const owed = new Map(outstanding.map((row) => [row.leaseId, row.outstanding]));
    return notices.map((notice) => ({
      ...noticeView(notice),
      tenantId: notice.tenantId,
      tenantName: `${notice.tenant.firstName} ${notice.tenant.lastName}`,
      unitNumber: notice.lease.rentableSpace.unit.number,
      propertyName: notice.lease.rentableSpace.unit.property.name,
      leaseOutstanding: formatMoney(owed.get(notice.leaseId) ?? ZERO),
      proofs: proofs.filter((p) => p.entityId === notice.id).map((p) => ({ id: p.id, contentType: p.contentType })),
    }));
  }

  /**
   * Confirms a tenant's notice by recording the payment (oldest charges first) and marking
   * the notice confirmed in the same transaction. Retrying returns the same payment.
   */
  async confirmNotice(
    organizationId: string,
    actorUserId: string,
    id: string,
    overrides: { amount?: string; method?: PaymentMethod; referenceNumber?: string; paidOn?: string },
  ) {
    const notice = await this.prisma.paymentNotice.findFirst({ where: { id, organizationId }, include: { tenant: true } });
    if (!notice) throw notFound('NOTICE_NOT_FOUND');
    if (notice.status === 'CONFIRMED' && notice.paymentId)
      return { notice: noticeView(await this.reload(notice.id)), alreadyConfirmed: true };
    if (notice.status !== 'SUBMITTED') throw new DomainError('NOTICE_NOT_PENDING', 409);

    const amount = parseMoney(overrides.amount ?? formatMoney(notice.amount));
    const paidOn = overrides.paidOn ?? formatDateOnly(notice.paidOn);
    const open = (await this.balances.charges(organizationId, { leaseId: notice.leaseId, status: 'open' })).sort(
      (a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.id.localeCompare(b.id),
    );
    let remaining = amount;
    const allocations: Array<{ chargeId: string; amount: string }> = [];
    for (const charge of open) {
      if (!remaining.greaterThan(0)) break;
      const applied = remaining.lessThan(charge.outstanding) ? remaining : charge.outstanding;
      allocations.push({ chargeId: charge.id, amount: formatMoney(applied) });
      remaining = remaining.minus(applied);
    }
    const payment = await this.payments.create(
      organizationId,
      actorUserId,
      {
        tenantId: notice.tenantId,
        leaseId: notice.leaseId,
        amount: formatMoney(amount),
        method: overrides.method ?? notice.method,
        referenceNumber: overrides.referenceNumber ?? notice.referenceNumber ?? undefined,
        notes: 'Reported by the tenant in the portal',
        // Noon in the Philippines keeps the payment on the reported calendar day.
        paidAt: `${paidOn}T04:00:00.000Z`,
        allocations,
      },
      `notice-${notice.id}`,
      async (tx, created) => {
        const claimed = await tx.paymentNotice.updateMany({
          where: { id: notice.id, organizationId, status: 'SUBMITTED' },
          data: { status: 'CONFIRMED', paymentId: created.id, reviewedBy: actorUserId, reviewedAt: new Date() },
        });
        if (claimed.count !== 1) throw new DomainError('NOTICE_NOT_PENDING', 409);
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'PAYMENT_NOTICE_CONFIRMED',
          entityType: 'PaymentNotice',
          entityId: notice.id,
          after: { paymentId: created.id, receiptNumber: created.receiptNumber },
        });
      },
    );
    if (notice.tenant.email)
      this.mailer.sendInBackground(
        {
          to: notice.tenant.email,
          subject: `Payment received — receipt ${payment.receiptNumber}`,
          text: [
            `Hi ${notice.tenant.firstName},`,
            '',
            `Your payment of ${payment.amount} on ${paidOn} has been confirmed. Receipt ${payment.receiptNumber} is in your tenant portal:`,
            this.mailer.link('/portal/payments', {}),
          ].join('\n'),
        },
        'PAYMENT_NOTICE_CONFIRMED',
      );
    return { notice: noticeView(await this.reload(notice.id)), payment, alreadyConfirmed: false };
  }

  async rejectNotice(organizationId: string, actorUserId: string, id: string, reason: string) {
    const notice = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentNotice.updateMany({
        where: { id, organizationId, status: 'SUBMITTED' },
        data: { status: 'REJECTED', rejectionReason: reason.trim(), reviewedBy: actorUserId, reviewedAt: new Date() },
      });
      if (!claimed.count) {
        const exists = await tx.paymentNotice.findFirst({ where: { id, organizationId }, select: { id: true } });
        throw exists ? new DomainError('NOTICE_NOT_PENDING', 409) : notFound('NOTICE_NOT_FOUND');
      }
      await audit(tx, { organizationId, actorUserId, action: 'PAYMENT_NOTICE_REJECTED', entityType: 'PaymentNotice', entityId: id });
      return tx.paymentNotice.findUniqueOrThrow({ where: { id }, include: { tenant: true } });
    });
    if (notice.tenant.email)
      this.mailer.sendInBackground(
        {
          to: notice.tenant.email,
          subject: 'We could not match your payment',
          text: [
            `Hi ${notice.tenant.firstName},`,
            '',
            `Your payment report of ${formatMoney(notice.amount)} on ${formatDateOnly(notice.paidOn)} was not confirmed:`,
            reason.trim(),
            '',
            'Check the details in your tenant portal or contact your landlord:',
            this.mailer.link('/portal/payments', {}),
          ].join('\n'),
        },
        'PAYMENT_NOTICE_REJECTED',
      );
    return { notice: noticeView(await this.reload(id)) };
  }

  private reload(id: string) {
    return this.prisma.paymentNotice.findUniqueOrThrow({
      where: { id },
      include: { payment: { include: { receipts: { orderBy: { issuedAt: 'desc' }, take: 1 } } } },
    });
  }
}
