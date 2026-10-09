import { Injectable, Logger } from '@nestjs/common';
import { audit } from '../common/audit.js';
import { verifyPassword } from '../common/crypto.js';
import { DomainError, notFound } from '../common/errors.js';
import { ZERO } from '../common/money.js';
import { PrismaService, type Tx } from '../common/prisma.service.js';
import { BalancesService } from '../billing/balances.service.js';
import { depositBalance } from '../payments/payments.service.js';
import { StorageService } from '../storage/storage.service.js';

const ERASED_NOTE = 'Removed when the tenant’s personal details were erased.';
/** Unroutable placeholder (RFC 2606) that keeps User.email unique. */
const erasedEmail = (id: string) => `erased-${id}@erased.invalid`;

/**
 * Data-subject requests under the Data Privacy Act: a full export of what the
 * workspace holds about one tenant, and erasure of their personal details.
 * Erasure anonymizes rather than deletes, so posted financial records
 * (charges, payments, receipts, deposits, lease contracts) stay intact.
 */
@Injectable()
export class TenantPrivacyService {
  private readonly logger = new Logger(TenantPrivacyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
    private readonly storage: StorageService,
  ) {}

  async export(organizationId: string, actorUserId: string, id: string) {
    const tenant = await this.prisma.tenant.findFirst({ where: { id, organizationId } });
    if (!tenant) throw notFound();
    const leases = await this.prisma.lease.findMany({
      where: { organizationId, OR: [{ primaryTenantId: id }, { occupants: { some: { tenantId: id } } }] },
      include: {
        rentableSpace: { select: { unit: { select: { number: true, property: { select: { name: true } } } } } },
        occupants: { where: { tenantId: id } },
        depositAccount: { include: { transactions: { orderBy: { occurredAt: 'asc' } } } },
      },
      orderBy: { startDate: 'asc' },
    });
    const leaseIds = leases.map((lease) => lease.id);
    const [charges, payments, paymentNotices, maintenance] = await Promise.all([
      this.prisma.charge.findMany({ where: { organizationId, leaseId: { in: leaseIds } }, include: { adjustments: true }, orderBy: { dueDate: 'asc' } }),
      this.prisma.payment.findMany({
        where: { organizationId, tenantId: id },
        include: { allocations: true, reversals: true, receipts: { select: { number: true, issuedAt: true, voidedAt: true } } },
        orderBy: { paidAt: 'asc' },
      }),
      this.prisma.paymentNotice.findMany({ where: { organizationId, tenantId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.maintenanceRequest.findMany({ where: { organizationId, tenantId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    const documents = await this.prisma.documentRecord.findMany({
      where: { organizationId, deletedAt: null, OR: this.documentScope(id, leaseIds, paymentNotices, maintenance) },
      select: { id: true, name: true, category: true, entityType: true, entityId: true, url: true, contentType: true, sizeBytes: true, sharedWithTenant: true, createdAt: true, storageKey: true },
      orderBy: { createdAt: 'asc' },
    });
    await this.prisma.$transaction((tx) =>
      audit(tx, { organizationId, actorUserId, action: 'TENANT_DATA_EXPORTED', entityType: 'Tenant', entityId: id }),
    );
    return {
      exportedAt: new Date().toISOString(),
      tenant,
      leases,
      charges,
      payments,
      paymentNotices,
      maintenance,
      // Files are not embedded; each uploaded one downloads from its path while signed in.
      documents: documents.map(({ storageKey, ...document }) => ({
        ...document,
        download: storageKey ? `/api/v1/documents/${document.id}/file` : null,
      })),
    };
  }

  async erase(organizationId: string, actorUserId: string, id: string, password: string) {
    const actor = await this.prisma.user.findUniqueOrThrow({ where: { id: actorUserId } });
    if (!(await verifyPassword(password, actor.passwordHash))) throw new DomainError('PASSWORD_INCORRECT', 422);
    const existing = await this.prisma.tenant.findFirst({ where: { id, organizationId }, select: { erasedAt: true } });
    if (!existing) throw notFound();
    if (existing.erasedAt) return { erased: true };
    const balance = (await this.balances.tenantBalances(organizationId, [id])).get(id) ?? ZERO;
    if (!balance.isZero()) throw new DomainError('TENANT_ERASE_BALANCE', 409);

    const storageKeys = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id, organizationId, erasedAt: null } });
      if (!tenant) return [];
      const leases = await tx.lease.findMany({
        where: { organizationId, OR: [{ primaryTenantId: id }, { occupants: { some: { tenantId: id } } }] },
        select: { id: true, status: true, depositAccount: { select: { transactions: { select: { type: true, amount: true } } } } },
      });
      if (leases.some((lease) => lease.status === 'ACTIVE' || lease.status === 'DRAFT'))
        throw new DomainError('TENANT_ERASE_ACTIVE_LEASE', 409);
      if (leases.some((lease) => lease.depositAccount && depositBalance(lease.depositAccount.transactions).greaterThan(ZERO)))
        throw new DomainError('TENANT_ERASE_DEPOSIT_HELD', 409);
      if (await tx.paymentNotice.count({ where: { organizationId, tenantId: id, status: 'SUBMITTED' } }))
        throw new DomainError('TENANT_ERASE_PENDING_REPORTS', 409);

      const now = new Date();
      await tx.tenant.update({
        where: { id },
        data: {
          firstName: 'Erased',
          lastName: `tenant ${id.slice(0, 8)}`,
          email: null,
          phone: null,
          permanentAddress: null,
          status: 'ARCHIVED',
          archivedAt: tenant.archivedAt ?? now,
          erasedAt: now,
        },
      });
      await this.erasePortalAccess(tx, organizationId, id, now);

      const notices = await tx.paymentNotice.findMany({ where: { organizationId, tenantId: id }, select: { id: true } });
      const requests = await tx.maintenanceRequest.findMany({ where: { organizationId, tenantId: id }, select: { id: true } });
      await tx.paymentNotice.updateMany({ where: { organizationId, tenantId: id }, data: { note: null } });
      await tx.maintenanceRequest.updateMany({ where: { organizationId, tenantId: id }, data: { description: ERASED_NOTE } });

      // Lease documents (signed contracts) stay with the lease records; files about the person go.
      const documents = await tx.documentRecord.findMany({
        where: { organizationId, deletedAt: null, OR: this.documentScope(id, [], notices, requests) },
        select: { id: true, storageKey: true },
      });
      await tx.documentRecord.updateMany({
        where: { id: { in: documents.map((document) => document.id) } },
        data: { deletedAt: now, name: 'Erased document', url: null, sharedWithTenant: false },
      });
      const keys = documents.flatMap((document) => (document.storageKey ? [document.storageKey] : []));
      for (const key of keys) await this.storage.remove(tx, key);

      await audit(tx, { organizationId, actorUserId, action: 'TENANT_ERASED', entityType: 'Tenant', entityId: id });
      return keys;
    });
    for (const key of storageKeys)
      await this.storage.processPending(key).catch(() => this.logger.error({ event: 'STORAGE_CLEANUP_DEFERRED', key }));
    return { erased: true };
  }

  /** Ends portal access; a login used for nothing else is anonymized and disabled too. */
  private async erasePortalAccess(tx: Tx, organizationId: string, tenantId: string, now: Date) {
    const memberships = await tx.membership.findMany({ where: { organizationId, tenantId }, select: { id: true, userId: true } });
    await tx.membership.updateMany({ where: { id: { in: memberships.map((m) => m.id) } }, data: { status: 'REVOKED' } });
    const userIds = memberships.map((m) => m.userId);
    await tx.session.updateMany({ where: { organizationId, userId: { in: userIds }, revokedAt: null }, data: { revokedAt: now } });

    const invitations = await tx.staffInvitation.findMany({ where: { organizationId, tenantId }, select: { id: true, status: true } });
    for (const invitation of invitations)
      await tx.staffInvitation.update({
        where: { id: invitation.id },
        data: { email: erasedEmail(invitation.id), ...(invitation.status === 'PENDING' ? { status: 'REVOKED' } : {}) },
      });

    const otherUses = await tx.membership.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: { in: ['ACTIVE', 'INVITED', 'SUSPENDED'] } },
    });
    const loginsToErase = userIds.filter((userId) => !otherUses.some((use) => use.userId === userId));
    for (const userId of loginsToErase) {
      await tx.user.update({
        where: { id: userId },
        // 'erased' is not a valid hash, so no password can match it.
        data: { email: erasedEmail(userId), displayName: 'Erased user', passwordHash: 'erased', disabledAt: now, mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userToken.deleteMany({ where: { userId } });
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    }
    // Queued mail to this person may name them; drop anything not yet sent.
    await tx.mailDelivery.updateMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        OR: [{ userId: { in: loginsToErase } }, { invitationId: { in: invitations.map((i) => i.id) } }],
      },
      data: { status: 'FAILED', encryptedBody: null, lastError: 'Cancelled: personal details erased' },
    });
  }

  private documentScope(tenantId: string, leaseIds: string[], notices: Array<{ id: string }>, requests: Array<{ id: string }>) {
    return [
      { entityType: 'Tenant', entityId: tenantId },
      ...(leaseIds.length ? [{ entityType: 'Lease', entityId: { in: leaseIds } }] : []),
      { entityType: 'PaymentNotice', entityId: { in: notices.map((n) => n.id) } },
      { entityType: 'MaintenanceRequest', entityId: { in: requests.map((r) => r.id) } },
    ];
  }
}
