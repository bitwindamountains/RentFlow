import { Injectable } from '@nestjs/common';
import type { MaintenancePriority, PaymentMethod, Prisma } from '@prisma/client';
import type { SessionContext } from '../auth/session.types.js';
import { BalancesService } from '../billing/balances.service.js';
import { audit } from '../common/audit.js';
import { addDays, formatDateOnly, parseDateOnly, todayInZone } from '../common/dates.js';
import { DomainError, notFound } from '../common/errors.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { formatMoney, parseMoney, sumMoney, ZERO } from '../common/money.js';
import { enqueueStaffAlert, NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../common/prisma.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import type { UploadType } from '../storage/file-store.service.js';
import { WorkService } from '../work/work.service.js';

/** How far back a tenant may report a payment. Older payments go through the landlord directly. */
const NOTICE_MAX_AGE_DAYS = 90;
const MAX_PENDING_NOTICES = 10;
const MAX_PROOFS_PER_NOTICE = 3;

export function noticeView(
  notice: Prisma.PaymentNoticeGetPayload<{ include: { payment: { include: { receipts: true } } } }>,
) {
  return {
    id: notice.id,
    leaseId: notice.leaseId,
    amount: formatMoney(notice.amount),
    method: notice.method,
    referenceNumber: notice.referenceNumber,
    paidOn: formatDateOnly(notice.paidOn),
    note: notice.note,
    status: notice.status,
    rejectionReason: notice.rejectionReason,
    reviewedAt: notice.reviewedAt?.toISOString() ?? null,
    paymentId: notice.paymentId,
    receiptNumber: notice.payment?.receipts[0]?.number ?? null,
    createdAt: notice.createdAt.toISOString(),
  };
}

const noticeInclude = { payment: { include: { receipts: { orderBy: { issuedAt: 'desc' }, take: 1 } } } } as const;

/**
 * Everything a signed-in tenant can see or do. Every query is scoped by the
 * organization AND the tenant bound to the session's membership, never by an
 * id supplied in the request alone.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
    private readonly payments: PaymentsService,
    private readonly idempotency: IdempotencyService,
    private readonly work: WorkService,
    private readonly notifications: NotificationsService,
  ) {}

  private scope(auth: SessionContext): { organizationId: string; tenantId: string } {
    if (auth.role !== 'TENANT' || !auth.tenantId) throw new DomainError('FORBIDDEN', 403);
    return { organizationId: auth.organizationId, tenantId: auth.tenantId };
  }

  async home(auth: SessionContext) {
    const { organizationId, tenantId } = this.scope(auth);
    const [organization, tenant, openCharges, balances, payments, notices] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { name: true, currency: true, timezone: true },
      }),
      this.prisma.tenant.findFirstOrThrow({
        where: { id: tenantId, organizationId },
        include: {
          primaryLeases: {
            where: { status: { in: ['ACTIVE', 'EXPIRED', 'TERMINATED'] } },
            orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
            take: 5,
            include: {
              rentableSpace: { include: { unit: { include: { property: true } } } },
              depositAccount: { include: { transactions: true } },
            },
          },
        },
      }),
      this.balances.charges(organizationId, { tenantId, status: 'open' }),
      this.balances.tenantBalances(organizationId, [tenantId]),
      this.recentPayments(organizationId, tenantId, 5),
      this.prisma.paymentNotice.findMany({
        where: { organizationId, tenantId, OR: [{ status: 'SUBMITTED' }, { reviewedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }] },
        include: noticeInclude,
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    const today = todayInZone(organization.timezone);
    const charges = [...openCharges].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    const isOverdue = (charge: (typeof charges)[number]) =>
      addDays(formatDateOnly(charge.dueDate), charge.gracePeriodDays) < today;
    const outstanding = sumMoney(charges.map((c) => c.outstanding));
    const overdue = sumMoney(charges.filter(isOverdue).map((c) => c.outstanding));
    const ledger = balances.get(tenantId) ?? ZERO;
    const next = charges.find((c) => !isOverdue(c)) ?? charges[0];
    return {
      organization: { name: organization.name, currency: organization.currency },
      tenant: { firstName: tenant.firstName, lastName: tenant.lastName },
      today,
      balance: {
        outstanding: formatMoney(outstanding),
        overdue: formatMoney(overdue),
        // Payments beyond what is billed are shown as credit on account.
        credit: formatMoney(ledger.isNegative() ? ledger.negated() : ZERO),
        nextDue: next ? { date: formatDateOnly(next.dueDate), amount: formatMoney(next.outstanding) } : null,
      },
      openCharges: charges.map((c) => ({
        id: c.id,
        leaseId: c.leaseId,
        description: c.description,
        billingPeriod: c.billingPeriod,
        dueDate: formatDateOnly(c.dueDate),
        amount: formatMoney(c.amount),
        outstanding: formatMoney(c.outstanding),
        overdue: isOverdue(c),
      })),
      leases: tenant.primaryLeases.map((lease) => ({
        id: lease.id,
        status: lease.status,
        propertyName: lease.rentableSpace.unit.property.name,
        address: `${lease.rentableSpace.unit.property.addressLine1}, ${lease.rentableSpace.unit.property.city}`,
        unitNumber: lease.rentableSpace.unit.number,
        startDate: formatDateOnly(lease.startDate),
        endDate: lease.endDate ? formatDateOnly(lease.endDate) : null,
        monthlyRent: formatMoney(lease.monthlyRent),
        dueDay: lease.dueDay,
        gracePeriodDays: lease.gracePeriodDays,
        depositHeld: lease.depositAccount
          ? formatMoney(
              lease.depositAccount.transactions.reduce(
                (sum, item) =>
                  ['RECEIPT', 'ADJUSTMENT'].includes(item.type) ? sum.plus(item.amount) : sum.minus(item.amount),
                ZERO,
              ),
            )
          : null,
      })),
      recentPayments: payments,
      notices: notices.map(noticeView),
    };
  }

  async paymentHistory(auth: SessionContext) {
    const { organizationId, tenantId } = this.scope(auth);
    const [payments, notices] = await Promise.all([
      this.recentPayments(organizationId, tenantId, 100),
      this.prisma.paymentNotice.findMany({
        where: { organizationId, tenantId },
        include: noticeInclude,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return { payments, notices: notices.map(noticeView) };
  }

  async receipt(auth: SessionContext, paymentId: string) {
    const { organizationId, tenantId } = this.scope(auth);
    const own = await this.prisma.payment.findFirst({ where: { id: paymentId, organizationId, tenantId }, select: { id: true } });
    if (!own) throw notFound('PAYMENT_NOT_FOUND');
    return this.payments.receipt(organizationId, own.id);
  }

  async maintenance(auth: SessionContext) {
    const { organizationId, tenantId } = this.scope(auth);
    const rows = await this.prisma.maintenanceRequest.findMany({
      where: { organizationId, tenantId },
      include: { unit: { select: { number: true } }, property: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      priority: row.priority,
      status: row.status,
      propertyName: row.property.name,
      unitNumber: row.unit?.number ?? null,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    }));
  }

  async reportMaintenance(
    auth: SessionContext,
    input: { leaseId?: string; title: string; description: string; priority: MaintenancePriority },
  ) {
    const { organizationId, tenantId } = this.scope(auth);
    const leases = await this.prisma.lease.findMany({
      where: { organizationId, primaryTenantId: tenantId, status: 'ACTIVE' },
      include: { rentableSpace: { include: { unit: true } } },
    });
    const lease = input.leaseId ? leases.find((item) => item.id === input.leaseId) : leases.length === 1 ? leases[0] : undefined;
    if (!lease)
      throw leases.length
        ? new DomainError('CHOOSE_LEASE', 422)
        : new DomainError('NO_ACTIVE_LEASE', 422);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.maintenanceRequest.create({
        data: {
          organizationId,
          propertyId: lease.rentableSpace.unit.propertyId,
          unitId: lease.rentableSpace.unitId,
          title: input.title.trim(),
          description: input.description.trim(),
          priority: input.priority,
          reportedBy: auth.userId,
          tenantId,
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId: auth.userId,
        action: 'MAINTENANCE_REPORTED_BY_TENANT',
        entityType: 'MaintenanceRequest',
        entityId: row.id,
        after: { priority: row.priority },
      });
      await enqueueStaffAlert(tx, { organizationId, topic: 'tenant.repair_reported', aggregateType: 'MaintenanceRequest', aggregateId: row.id });
      return { id: row.id, status: row.status, createdAt: row.createdAt.toISOString() };
    });
    this.notifications.kick();
    return created;
  }

  /** "I paid": the tenant tells the landlord about a payment. Nothing is posted until staff confirm it. */
  async submitNotice(
    auth: SessionContext,
    input: { leaseId: string; amount: string; method: PaymentMethod; referenceNumber?: string; paidOn: string; note?: string },
    key: string,
  ) {
    const { organizationId, tenantId } = this.scope(auth);
    const amount = parseMoney(input.amount);
    const organization = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
    const today = todayInZone(organization.timezone);
    if (input.paidOn > today) throw new DomainError('FUTURE_PAYMENT_DATE', 422);
    if (input.paidOn < addDays(today, -NOTICE_MAX_AGE_DAYS)) throw new DomainError('PAYMENT_DATE_TOO_OLD', 422);
    const notice = await this.idempotency.execute({ organizationId, key, operation: 'PAYMENT_NOTICE' }, { ...input, tenantId }, async (tx) => {
      const lease = await tx.lease.findFirst({ where: { id: input.leaseId, organizationId, primaryTenantId: tenantId }, select: { id: true } });
      if (!lease) throw notFound('LEASE_NOT_FOUND');
      const pending = await tx.paymentNotice.count({ where: { organizationId, tenantId, status: 'SUBMITTED' } });
      if (pending >= MAX_PENDING_NOTICES) throw new DomainError('TOO_MANY_PENDING_NOTICES', 429);
      const notice = await tx.paymentNotice.create({
        data: {
          organizationId,
          tenantId,
          leaseId: lease.id,
          amount,
          method: input.method,
          referenceNumber: input.referenceNumber?.trim() || null,
          paidOn: parseDateOnly(input.paidOn),
          note: input.note?.trim() || null,
          submittedBy: auth.userId,
        },
        include: noticeInclude,
      });
      await audit(tx, {
        organizationId,
        actorUserId: auth.userId,
        action: 'PAYMENT_NOTICE_SUBMITTED',
        entityType: 'PaymentNotice',
        entityId: notice.id,
        after: { amount, method: input.method, paidOn: input.paidOn },
      });
      // Written with the notice, so a replayed request never alerts staff twice.
      await enqueueStaffAlert(tx, { organizationId, topic: 'tenant.payment_reported', aggregateType: 'PaymentNotice', aggregateId: notice.id });
      return noticeView(notice);
    });
    this.notifications.kick();
    return notice;
  }

  async withdrawNotice(auth: SessionContext, id: string) {
    const { organizationId, tenantId } = this.scope(auth);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentNotice.updateMany({
        where: { id, organizationId, tenantId, status: 'SUBMITTED' },
        data: { status: 'WITHDRAWN' },
      });
      if (!updated.count) throw notFound('NOTICE_NOT_FOUND');
      await audit(tx, {
        organizationId,
        actorUserId: auth.userId,
        action: 'PAYMENT_NOTICE_WITHDRAWN',
        entityType: 'PaymentNotice',
        entityId: id,
      });
      return { withdrawn: true };
    });
  }

  /** Attaches a screenshot or PDF (e.g. the GCash confirmation) to the tenant's own pending notice. */
  async attachProof(auth: SessionContext, id: string, contentType: UploadType, body: Buffer) {
    const { organizationId, tenantId } = this.scope(auth);
    const notice = await this.prisma.paymentNotice.findFirst({ where: { id, organizationId, tenantId } });
    if (!notice) throw notFound('NOTICE_NOT_FOUND');
    if (notice.status !== 'SUBMITTED') throw new DomainError('NOTICE_NOT_PENDING', 409);
    const proofs = await this.prisma.documentRecord.count({
      where: { organizationId, entityType: 'PaymentNotice', entityId: id, deletedAt: null },
    });
    if (proofs >= MAX_PROOFS_PER_NOTICE) throw new DomainError('TOO_MANY_PROOFS', 422);
    const document = await this.work.uploadDocument(
      organizationId,
      auth.userId,
      {
        name: `Payment proof ${notice.referenceNumber ?? formatDateOnly(notice.paidOn)}`.slice(0, 160),
        category: 'Payment proof',
        entityType: 'PaymentNotice',
        entityId: id,
        contentType,
      },
      body,
    );
    return { id: document.id, contentType: document.contentType, sizeBytes: document.sizeBytes };
  }

  private async recentPayments(organizationId: string, tenantId: string, take: number) {
    const rows = await this.prisma.payment.findMany({
      where: { organizationId, tenantId, status: { in: ['POSTED', 'REVERSED'] } },
      include: { receipts: { orderBy: { issuedAt: 'desc' }, take: 1 } },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return rows.map((payment) => ({
      id: payment.id,
      amount: formatMoney(payment.amount),
      method: payment.method,
      referenceNumber: payment.referenceNumber,
      paidAt: payment.paidAt.toISOString(),
      status: payment.status,
      receiptNumber: payment.receipts[0]?.number ?? null,
    }));
  }
}
