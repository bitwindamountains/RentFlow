import { Injectable } from '@nestjs/common';
import { audit } from '../common/audit.js';
import { formatDateOnly } from '../common/dates.js';
import { DomainError, notFound } from '../common/errors.js';
import { formatMoney, ZERO } from '../common/money.js';
import { PrismaService } from '../common/prisma.service.js';
import { BalancesService, chargeView } from '../billing/balances.service.js';

export interface TenantInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

const clean = (value?: string) => value?.trim() || null;

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
  ) {}

  async list(organizationId: string, includeArchived = false) {
    const tenants = await this.prisma.tenant.findMany({
      where: { organizationId, ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }) },
      include: {
        primaryLeases: {
          where: { status: 'ACTIVE' },
          select: {
            id: true,
            rentableSpace: {
              select: { unit: { select: { number: true, property: { select: { name: true } } } } },
            },
          },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    const balances = await this.balances.tenantBalances(organizationId);
    return tenants.map((tenant) => ({
      id: tenant.id,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      email: tenant.email,
      phone: tenant.phone,
      status: tenant.status,
      balance: formatMoney(balances.get(tenant.id) ?? ZERO),
      rentals: tenant.primaryLeases.map((lease) => ({
        leaseId: lease.id,
        unitNumber: lease.rentableSpace.unit.number,
        propertyName: lease.rentableSpace.unit.property.name,
      })),
    }));
  }

  async detail(organizationId: string, id: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, organizationId },
      include: {
        primaryLeases: {
          orderBy: { startDate: 'desc' },
          include: {
            rentableSpace: { include: { unit: { include: { property: { select: { id: true, name: true } } } } } },
            depositAccount: { include: { transactions: true } },
          },
        },
        payments: {
          orderBy: { paidAt: 'desc' },
          take: 50,
          include: { receipts: { where: { voidedAt: null }, take: 1 } },
        },
      },
    });
    if (!tenant) throw notFound();
    const [balances, openCharges, documents] = await Promise.all([
      this.balances.tenantBalances(organizationId, [id]),
      this.balances.charges(organizationId, { tenantId: id, status: 'open' }),
      this.prisma.documentRecord.findMany({
        where: { organizationId, entityType: 'Tenant', entityId: id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      id: tenant.id,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      email: tenant.email,
      phone: tenant.phone,
      status: tenant.status,
      createdAt: tenant.createdAt.toISOString(),
      balance: formatMoney(balances.get(id) ?? ZERO),
      leases: tenant.primaryLeases.map((lease) => ({
        id: lease.id,
        status: lease.status,
        startDate: formatDateOnly(lease.startDate),
        endDate: lease.endDate ? formatDateOnly(lease.endDate) : null,
        monthlyRent: formatMoney(lease.monthlyRent),
        billingDay: lease.billingDay,
        dueDay: lease.dueDay,
        unitNumber: lease.rentableSpace.unit.number,
        propertyId: lease.rentableSpace.unit.property.id,
        propertyName: lease.rentableSpace.unit.property.name,
        deposit: lease.depositAccount
          ? {
              required: formatMoney(lease.depositAccount.requiredAmount),
              held: formatMoney(
                lease.depositAccount.transactions.reduce(
                  (sum, item) =>
                    ['RECEIPT', 'ADJUSTMENT'].includes(item.type) ? sum.plus(item.amount) : sum.minus(item.amount),
                  ZERO,
                ),
              ),
            }
          : null,
      })),
      openCharges: openCharges.map(chargeView).reverse(),
      payments: tenant.payments.map((payment) => ({
        id: payment.id,
        leaseId: payment.leaseId,
        amount: formatMoney(payment.amount),
        method: payment.method,
        referenceNumber: payment.referenceNumber,
        paidAt: payment.paidAt.toISOString(),
        status: payment.status,
        receiptNumber: payment.receipts[0]?.number ?? null,
      })),
      documents: documents.map((doc) => ({
        id: doc.id,
        name: doc.name,
        category: doc.category,
        kind: doc.storageKey ? ('file' as const) : ('link' as const),
        url: doc.url,
        createdAt: doc.createdAt.toISOString(),
      })),
    };
  }

  async create(organizationId: string, actorUserId: string, input: TenantInput) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          organizationId,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          email: clean(input.email)?.toLowerCase(),
          phone: clean(input.phone),
          status: 'ACTIVE',
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'TENANT_CREATED',
        entityType: 'Tenant',
        entityId: tenant.id,
        after: tenant,
      });
      return {
        id: tenant.id,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        email: tenant.email,
        phone: tenant.phone,
        status: tenant.status,
        balance: '0.00',
        rentals: [],
      };
    });
  }

  async update(organizationId: string, actorUserId: string, id: string, input: TenantInput) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.tenant.findFirst({ where: { id, organizationId } });
      if (!before) throw notFound();
      const after = await tx.tenant.update({
        where: { id },
        data: {
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          email: clean(input.email)?.toLowerCase() ?? null,
          phone: clean(input.phone),
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'TENANT_UPDATED',
        entityType: 'Tenant',
        entityId: id,
        before,
        after,
      });
      return { updated: true };
    });
  }

  /** Archives a former tenant; financial history is preserved. */
  async archive(organizationId: string, actorUserId: string, id: string) {
    const balances = await this.balances.tenantBalances(organizationId, [id]);
    if (!(balances.get(id) ?? ZERO).isZero()) throw new DomainError('TENANT_HAS_BALANCE', 409);
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id, organizationId },
        include: { primaryLeases: { where: { status: 'ACTIVE' }, select: { id: true } } },
      });
      if (!tenant) throw notFound();
      if (tenant.primaryLeases.length) throw new DomainError('TENANT_HAS_ACTIVE_LEASE', 409);
      await tx.tenant.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'TENANT_ARCHIVED',
        entityType: 'Tenant',
        entityId: id,
      });
      return { archived: true };
    });
  }
}
