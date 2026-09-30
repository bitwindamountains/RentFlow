import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { audit } from '../common/audit.js';
import {
  addDays,
  firstOfNextMonth,
  formatDateOnly,
  parseDateOnly,
  periodOf,
  todayInZone,
} from '../common/dates.js';
import { DomainError, notFound } from '../common/errors.js';
import { formatMoney, parseMoney } from '../common/money.js';
import { PrismaService, type Tx } from '../common/prisma.service.js';
import { postCharge } from '../billing/ledger.js';
import { prorateFromDate, prorateRange } from '../billing/periods.js';

export type FirstMonthMode = 'FULL' | 'PRORATED' | 'NONE';

export interface NewLease {
  organizationId: string;
  actorUserId: string;
  rentableSpaceId: string;
  tenantId: string;
  startDate: string;
  endDate?: string;
  monthlyRent: Prisma.Decimal;
  billingDay: number;
  dueDay: number;
  gracePeriodDays?: number;
  depositRequired?: Prisma.Decimal;
  firstMonth?: FirstMonthMode;
  firstChargeDueDate?: string;
  firstChargeDescription?: string;
}

const leaseInclude = {
  primaryTenant: { select: { id: true, firstName: true, lastName: true } },
  rentableSpace: { select: { unit: { select: { id: true, number: true, type: true, property: { select: { id: true, name: true } } } } } },
} satisfies Prisma.LeaseInclude;

type LeaseWithRelations = Prisma.LeaseGetPayload<{ include: typeof leaseInclude }>;

export function leaseView(lease: LeaseWithRelations) {
  const unit = lease.rentableSpace.unit;
  return {
    id: lease.id,
    tenantId: lease.primaryTenantId,
    tenantName: `${lease.primaryTenant.firstName} ${lease.primaryTenant.lastName}`,
    tenant: lease.primaryTenant,
    unitId: unit.id,
    unit: { id: unit.id, number: unit.number, type: unit.type },
    propertyId: unit.property.id,
    propertyName: unit.property.name,
    startDate: formatDateOnly(lease.startDate),
    endDate: lease.endDate ? formatDateOnly(lease.endDate) : null,
    monthlyRent: formatMoney(lease.monthlyRent),
    depositRequired: formatMoney(lease.depositRequired),
    billingDay: lease.billingDay,
    dueDay: lease.dueDay,
    gracePeriodDays: lease.gracePeriodDays,
    status: lease.status,
  };
}

/**
 * Creates an active lease, its recurring rent schedule (from the first of the
 * following month), and the move-in month's rent charge in one transaction.
 */
export async function createLeaseInTx(tx: Tx, input: NewLease) {
  if (input.endDate && input.endDate < input.startDate) throw new DomainError('INVALID_LEASE_DATES');
  const claimed = await tx.rentableSpace.updateMany({
    where: { id: input.rentableSpaceId, organizationId: input.organizationId, status: 'AVAILABLE' },
    data: { status: 'UNAVAILABLE' },
  });
  const occupied = await tx.lease.findFirst({
    where: { rentableSpaceId: input.rentableSpaceId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (claimed.count !== 1 || occupied) throw new DomainError('UNIT_OCCUPIED', 409);

  const startDate = parseDateOnly(input.startDate);
  const endDate = input.endDate ? parseDateOnly(input.endDate) : undefined;
  const scheduleStart = firstOfNextMonth(input.startDate);
  const lease = await tx.lease.create({
    data: {
      organizationId: input.organizationId,
      rentableSpaceId: input.rentableSpaceId,
      primaryTenantId: input.tenantId,
      startDate,
      endDate,
      monthlyRent: input.monthlyRent,
      depositRequired: input.depositRequired ?? 0,
      billingDay: input.billingDay,
      dueDay: input.dueDay,
      gracePeriodDays: input.gracePeriodDays ?? 0,
      status: 'ACTIVE',
      activatedAt: new Date(),
      occupants: { create: { tenantId: input.tenantId, moveInAt: startDate } },
      ...(!input.endDate || scheduleStart <= input.endDate
        ? {
            billingSchedules: {
              create: {
                organizationId: input.organizationId,
                chargeType: 'RENT',
                description: 'Monthly rent',
                amount: input.monthlyRent,
                billingDay: input.billingDay,
                dueDay: input.dueDay,
                startsOn: parseDateOnly(scheduleStart),
                endsOn: endDate,
              },
            },
          }
        : {}),
      ...(input.depositRequired?.greaterThan(0)
        ? { depositAccount: { create: { organizationId: input.organizationId, requiredAmount: input.depositRequired } } }
        : {}),
    },
    include: leaseInclude,
  });
  await tx.tenant.update({ where: { id: input.tenantId }, data: { status: 'ACTIVE', archivedAt: null } });

  const mode = input.firstMonth ?? 'FULL';
  let firstChargeId: string | undefined;
  if (mode !== 'NONE') {
    const monthEnd = addDays(scheduleStart, -1);
    const amount =
      mode === 'FULL'
        ? input.monthlyRent
        : input.endDate && input.endDate < monthEnd
          ? prorateRange(input.monthlyRent, input.startDate, input.endDate)
          : prorateFromDate(input.monthlyRent, input.startDate);
    const charge = await postCharge(tx, {
      organizationId: input.organizationId,
      leaseId: lease.id,
      type: 'RENT',
      description:
        input.firstChargeDescription ??
        (mode === 'PRORATED' && !amount.equals(input.monthlyRent) ? 'Move-in rent (prorated)' : 'Move-in month rent'),
      amount,
      dueDate: parseDateOnly(input.firstChargeDueDate ?? input.startDate),
      billingPeriod: periodOf(input.startDate),
      actorUserId: input.actorUserId,
    });
    firstChargeId = charge.id;
  }
  await audit(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'LEASE_CREATED',
    entityType: 'Lease',
    entityId: lease.id,
    after: { ...lease, firstMonth: mode },
  });
  return { lease, firstChargeId };
}

@Injectable()
export class LeasesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string) {
    const leases = await this.prisma.lease.findMany({
      where: { organizationId },
      include: leaseInclude,
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    });
    return leases.map(leaseView);
  }

  async create(
    organizationId: string,
    actorUserId: string,
    input: {
      unitId: string;
      tenantId: string;
      startDate: string;
      endDate?: string;
      monthlyRent: string;
      billingDay: number;
      dueDay: number;
      gracePeriodDays?: number;
      depositRequired?: string;
      firstMonth?: FirstMonthMode;
    },
  ) {
    const monthlyRent = parseMoney(input.monthlyRent);
    const depositRequired = input.depositRequired ? parseMoney(input.depositRequired, { allowZero: true }) : undefined;
    const { lease } = await this.prisma.serializable(async (tx) => {
      const [space, tenant] = await Promise.all([
        tx.rentableSpace.findFirst({
          where: { unitId: input.unitId, organizationId },
          orderBy: { createdAt: 'asc' },
        }),
        tx.tenant.findFirst({ where: { id: input.tenantId, organizationId } }),
      ]);
      if (!space || !tenant) throw notFound();
      return createLeaseInTx(tx, {
        organizationId,
        actorUserId,
        rentableSpaceId: space.id,
        tenantId: tenant.id,
        startDate: input.startDate,
        endDate: input.endDate,
        monthlyRent,
        billingDay: input.billingDay,
        dueDay: input.dueDay,
        gracePeriodDays: input.gracePeriodDays,
        depositRequired,
        firstMonth: input.firstMonth,
      });
    });
    return leaseView(lease);
  }

  async renew(organizationId: string, actorUserId: string, leaseId: string, input: { endDate: string; monthlyRent?: string }) {
    const endDate = parseDateOnly(input.endDate);
    return this.prisma.serializable(async (tx) => {
      const lease = await tx.lease.findFirst({ where: { id: leaseId, organizationId, status: 'ACTIVE' } });
      if (!lease) throw notFound('LEASE_NOT_FOUND');
      if (input.monthlyRent && !parseMoney(input.monthlyRent).equals(lease.monthlyRent))
        throw new DomainError('RENT_CHANGE_REQUIRES_NEW_LEASE');
      if (endDate <= (lease.endDate ?? lease.startDate)) throw new DomainError('INVALID_LEASE_DATES');
      const updated = await tx.lease.update({ where: { id: lease.id }, data: { endDate } });
      // Extend only the schedule that ran to the old end date (the current rent).
      await tx.billingSchedule.updateMany({
        where: {
          leaseId: lease.id,
          status: 'ACTIVE',
          OR: [{ endsOn: null }, ...(lease.endDate ? [{ endsOn: lease.endDate }] : [])],
        },
        data: { endsOn: endDate },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'LEASE_RENEWED',
        entityType: 'Lease',
        entityId: lease.id,
        before: { endDate: lease.endDate },
        after: { endDate: updated.endDate },
      });
      return { id: updated.id, endDate: formatDateOnly(endDate), status: updated.status };
    });
  }

  /**
   * Changes rent from the first bill issued on or after `effectiveFrom`.
   * Already-billed periods are never rewritten.
   */
  async changeRent(
    organizationId: string,
    actorUserId: string,
    leaseId: string,
    input: { effectiveFrom: string; monthlyRent: string },
  ) {
    const amount = parseMoney(input.monthlyRent);
    const effective = parseDateOnly(input.effectiveFrom);
    return this.prisma.serializable(async (tx) => {
      const lease = await tx.lease.findFirst({
        where: { id: leaseId, organizationId, status: 'ACTIVE' },
        include: { organization: { select: { timezone: true } } },
      });
      if (!lease) throw notFound('LEASE_NOT_FOUND');
      const today = todayInZone(lease.organization.timezone);
      if (input.effectiveFrom < today)
        throw new DomainError('INVALID_DATE', 400, 'The new rent must start today or later.');
      if (lease.endDate && input.effectiveFrom > formatDateOnly(lease.endDate))
        throw new DomainError('INVALID_LEASE_DATES', 400, 'The new rent must start before the lease ends.');
      const day = String(lease.billingDay).padStart(2, '0');
      const firstBill =
        effective.getUTCDate() <= lease.billingDay
          ? `${input.effectiveFrom.slice(0, 8)}${day}`
          : `${firstOfNextMonth(input.effectiveFrom).slice(0, 8)}${day}`;
      const billed = await tx.charge.findFirst({
        where: { leaseId, type: 'RENT', status: 'POSTED', billingPeriod: { gte: periodOf(firstBill) } },
      });
      if (billed) throw new DomainError('RENT_CHANGE_AFTER_BILLED', 409);
      const current = await tx.billingSchedule.findFirst({
        where: { leaseId, chargeType: 'RENT', status: 'ACTIVE' },
        orderBy: { startsOn: 'desc' },
      });
      if (current && current.startsOn >= effective) {
        await tx.billingSchedule.update({ where: { id: current.id }, data: { amount } });
      } else {
        if (current)
          await tx.billingSchedule.update({
            where: { id: current.id },
            data: { endsOn: parseDateOnly(addDays(input.effectiveFrom, -1)) },
          });
        await tx.billingSchedule.create({
          data: {
            organizationId,
            leaseId,
            chargeType: 'RENT',
            description: 'Monthly rent',
            amount,
            billingDay: lease.billingDay,
            dueDay: lease.dueDay,
            startsOn: effective,
            endsOn: lease.endDate,
          },
        });
      }
      await tx.lease.update({ where: { id: leaseId }, data: { monthlyRent: amount } });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'LEASE_RENT_CHANGED',
        entityType: 'Lease',
        entityId: leaseId,
        before: { monthlyRent: lease.monthlyRent },
        after: { monthlyRent: amount, effectiveFrom: input.effectiveFrom, firstBill },
      });
      return { id: leaseId, monthlyRent: formatMoney(amount), effectiveFrom: input.effectiveFrom, firstBill };
    });
  }

  /** Ends a lease immediately (today or a past date); balances remain for settlement. */
  async terminate(organizationId: string, actorUserId: string, leaseId: string, input: { endDate: string; reason: string }) {
    const ended = parseDateOnly(input.endDate);
    return this.prisma.serializable(async (tx) => {
      const lease = await tx.lease.findFirst({
        where: { id: leaseId, organizationId, status: 'ACTIVE' },
        include: { organization: { select: { timezone: true } } },
      });
      if (!lease) throw notFound('LEASE_NOT_FOUND');
      if (ended < lease.startDate) throw new DomainError('INVALID_LEASE_DATES');
      if (input.endDate > todayInZone(lease.organization.timezone))
        throw new DomainError('FUTURE_TERMINATION_NOT_ALLOWED');
      const updated = await this.close(tx, lease.id, lease.rentableSpaceId, 'TERMINATED', ended);
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'LEASE_TERMINATED',
        entityType: 'Lease',
        entityId: lease.id,
        before: { status: lease.status, endDate: lease.endDate },
        after: { status: updated.status, endDate: updated.endDate },
        reason: input.reason,
      });
      return { id: updated.id, status: updated.status, endDate: formatDateOnly(ended) };
    });
  }

  /** Marks leases whose end date has passed as EXPIRED and frees their units. */
  async expireEnded(organizationId: string, today: string): Promise<number> {
    const due = await this.prisma.lease.findMany({
      where: { organizationId, status: 'ACTIVE', endDate: { lt: parseDateOnly(today) } },
      select: { id: true, rentableSpaceId: true, endDate: true },
    });
    for (const lease of due)
      await this.prisma.serializable(async (tx) => {
        const current = await tx.lease.findFirst({ where: { id: lease.id, status: 'ACTIVE' } });
        if (!current) return;
        await this.close(tx, lease.id, lease.rentableSpaceId, 'EXPIRED', lease.endDate!);
        await audit(tx, {
          organizationId,
          action: 'LEASE_EXPIRED',
          entityType: 'Lease',
          entityId: lease.id,
        });
      });
    return due.length;
  }

  async ledger(organizationId: string, leaseId: string) {
    const lease = await this.prisma.lease.findFirst({ where: { id: leaseId, organizationId }, select: { id: true } });
    if (!lease) throw notFound('LEASE_NOT_FOUND');
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { organizationId, leaseId },
      include: {
        charge: { select: { description: true, dueDate: true } },
        payment: { select: { method: true, receipts: { select: { number: true }, take: 1 } } },
      },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });
    let balance = new Prisma.Decimal(0);
    return entries.map((entry) => {
      balance = balance.plus(entry.debit).minus(entry.credit);
      return {
        id: entry.id,
        type: entry.type,
        occurredAt: entry.occurredAt.toISOString(),
        description:
          entry.charge?.description ??
          (entry.payment ? `Payment ${entry.payment.receipts[0]?.number ?? ''} (${entry.payment.method})`.trim() : entry.type),
        chargeId: entry.chargeId,
        paymentId: entry.paymentId,
        debit: formatMoney(entry.debit),
        credit: formatMoney(entry.credit),
        balance: formatMoney(balance),
      };
    });
  }

  private async close(
    tx: Tx,
    leaseId: string,
    rentableSpaceId: string,
    status: 'TERMINATED' | 'EXPIRED',
    ended: Date,
  ) {
    const updated = await tx.lease.update({
      where: { id: leaseId },
      data: { status, endDate: ended, ...(status === 'TERMINATED' ? { terminatedAt: new Date() } : {}) },
    });
    await tx.leaseOccupant.updateMany({ where: { leaseId, moveOutAt: null }, data: { moveOutAt: ended } });
    await tx.rentableSpace.update({ where: { id: rentableSpaceId }, data: { status: 'AVAILABLE' } });
    await tx.billingSchedule.updateMany({
      where: { leaseId, status: 'ACTIVE' },
      data: { status: 'ENDED' },
    });
    await tx.billingSchedule.updateMany({
      // Schedules that had not started yet simply end; their window stays valid.
      where: { leaseId, startsOn: { lte: ended }, OR: [{ endsOn: null }, { endsOn: { gt: ended } }] },
      data: { endsOn: ended },
    });
    return updated;
  }
}
