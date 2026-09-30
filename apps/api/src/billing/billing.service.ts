import { Injectable } from '@nestjs/common';
import type { AdjustmentType, ChargeType } from '@prisma/client';
import { audit } from '../common/audit.js';
import { formatDateOnly, parseDateOnly, periodOf, todayInZone } from '../common/dates.js';
import { DomainError, notFound } from '../common/errors.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { formatMoney, parseMoney } from '../common/money.js';
import { isUniqueViolation, PrismaService } from '../common/prisma.service.js';
import { decodeCursor, encodeCursor, type Page } from '../common/validation.js';
import { BalancesService, chargeView } from './balances.service.js';
import { postCharge } from './ledger.js';
import { duePeriods } from './periods.js';

export interface ChargeInput {
  leaseId: string;
  type: ChargeType;
  description: string;
  amount: string;
  dueDate: string;
  billingPeriod?: string;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listSchedules(organizationId: string) {
    const rows = await this.prisma.billingSchedule.findMany({
      where: { organizationId },
      include: {
        lease: {
          select: {
            id: true,
            status: true,
            primaryTenant: { select: { firstName: true, lastName: true } },
            rentableSpace: { select: { unit: { select: { number: true } } } },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      leaseId: row.leaseId,
      tenantName: `${row.lease.primaryTenant.firstName} ${row.lease.primaryTenant.lastName}`,
      unitNumber: row.lease.rentableSpace.unit.number,
      chargeType: row.chargeType,
      description: row.description,
      amount: formatMoney(row.amount),
      billingDay: row.billingDay,
      dueDay: row.dueDay,
      startsOn: formatDateOnly(row.startsOn),
      endsOn: row.endsOn ? formatDateOnly(row.endsOn) : null,
      status: row.status,
    }));
  }

  async createSchedule(
    organizationId: string,
    actorUserId: string,
    input: {
      leaseId: string;
      type: ChargeType;
      description: string;
      amount: string;
      billingDay: number;
      dueDay: number;
      startsOn: string;
      endsOn?: string;
    },
  ) {
    const amount = parseMoney(input.amount);
    const startsOn = parseDateOnly(input.startsOn);
    const endsOn = input.endsOn ? parseDateOnly(input.endsOn) : undefined;
    if (endsOn && endsOn < startsOn) throw new DomainError('INVALID_LEASE_DATES');
    const schedule = await this.prisma.serializable(async (tx) => {
      const lease = await tx.lease.findFirst({
        where: { id: input.leaseId, organizationId, status: 'ACTIVE' },
      });
      if (!lease) throw notFound('LEASE_NOT_FOUND');
      if (
        input.type === 'RENT' &&
        (await tx.billingSchedule.findFirst({
          where: { leaseId: lease.id, chargeType: 'RENT', status: 'ACTIVE' },
        }))
      )
        throw new DomainError('RENT_SCHEDULE_EXISTS', 409);
      const created = await tx.billingSchedule.create({
        data: {
          organizationId,
          leaseId: lease.id,
          chargeType: input.type,
          description: input.description.trim(),
          amount,
          billingDay: input.billingDay,
          dueDay: input.dueDay,
          startsOn,
          endsOn,
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'BILLING_SCHEDULE_CREATED',
        entityType: 'BillingSchedule',
        entityId: created.id,
        after: created,
      });
      return created;
    });
    return { ...schedule, amount: formatMoney(schedule.amount) };
  }

  async listCharges(
    organizationId: string,
    query: { status?: 'open' | 'overdue' | 'all'; leaseId?: string; cursor?: string; limit?: number; q?: string },
  ): Promise<Page<ReturnType<typeof chargeView>>> {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);
    const rows = await this.balances.charges(organizationId, {
      status: query.status ?? 'all',
      leaseId: query.leaseId,
      q: query.q?.trim() || undefined,
      today: await this.today(organizationId),
      before: cursor ? { dueDate: cursor.sortValue, id: cursor.id } : undefined,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit).map(chargeView);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last.dueDate, last.id) : null,
    };
  }

  async openCharges(organizationId: string, leaseId: string) {
    if (!(await this.prisma.lease.findFirst({ where: { id: leaseId, organizationId }, select: { id: true } })))
      throw notFound('LEASE_NOT_FOUND');
    const rows = await this.balances.charges(organizationId, { status: 'open', leaseId });
    // Oldest first: the order in which payments are allocated.
    return rows.map(chargeView).reverse();
  }

  async createCharge(organizationId: string, actorUserId: string, input: ChargeInput, key: string) {
    const amount = parseMoney(input.amount);
    const dueDate = parseDateOnly(input.dueDate);
    const billingPeriod = input.billingPeriod ?? (input.type === 'RENT' ? periodOf(input.dueDate) : undefined);
    return this.idempotency.execute(
      { organizationId, key, operation: 'CREATE_CHARGE' },
      input,
      async (tx) => {
        const lease = await tx.lease.findFirst({
          where: { id: input.leaseId, organizationId, status: 'ACTIVE' },
        });
        if (!lease) throw notFound('LEASE_NOT_FOUND');
        const charge = await postCharge(tx, {
          organizationId,
          leaseId: lease.id,
          type: input.type,
          description: input.description,
          amount,
          dueDate,
          billingPeriod,
          actorUserId,
        });
        return {
          id: charge.id,
          leaseId: charge.leaseId,
          type: charge.type,
          description: charge.description,
          amount: formatMoney(charge.amount),
          dueDate: formatDateOnly(charge.dueDate),
          billingPeriod: charge.billingPeriod,
          status: charge.status,
        };
      },
    );
  }

  /** Discounts, waivers, and credit notes reduce what the tenant owes on a charge. */
  async adjustCharge(
    organizationId: string,
    actorUserId: string,
    chargeId: string,
    input: { type: Exclude<AdjustmentType, 'REVERSAL'>; amount: string; reason: string },
  ) {
    const amount = parseMoney(input.amount);
    return this.prisma.serializable(async (tx) => {
      const [row] = await this.balances.charges(organizationId, { chargeIds: [chargeId] }, tx);
      if (!row) throw notFound();
      if (row.status !== 'POSTED' || !row.outstanding.greaterThan(0))
        throw new DomainError('CHARGE_NOT_OPEN', 409);
      if (amount.greaterThan(row.outstanding))
        throw new DomainError('INVALID_MONEY', 422, `The adjustment cannot exceed the outstanding ${formatMoney(row.outstanding)}.`);
      const adjustment = await tx.chargeAdjustment.create({
        data: {
          organizationId,
          chargeId,
          type: input.type,
          amount,
          reason: input.reason.trim(),
          createdBy: actorUserId,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          organizationId,
          leaseId: row.leaseId,
          chargeId,
          type: 'CHARGE_ADJUSTMENT',
          credit: amount,
          occurredAt: new Date(),
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: `CHARGE_${input.type}`,
        entityType: 'Charge',
        entityId: chargeId,
        after: adjustment,
        reason: input.reason,
      });
      return {
        id: adjustment.id,
        chargeId,
        type: adjustment.type,
        amount: formatMoney(adjustment.amount),
        outstanding: formatMoney(row.outstanding.minus(amount)),
      };
    });
  }

  /** Voids a charge posted in error. Payments must be reversed first. */
  async voidCharge(organizationId: string, actorUserId: string, chargeId: string, reason: string) {
    return this.prisma.serializable(async (tx) => {
      const [row] = await this.balances.charges(organizationId, { chargeIds: [chargeId] }, tx);
      if (!row) throw notFound();
      if (row.status !== 'POSTED') throw new DomainError('CHARGE_NOT_OPEN', 409);
      if (row.paid.greaterThan(0)) throw new DomainError('CHARGE_HAS_PAYMENTS', 409);
      const remaining = row.amount.minus(row.adjusted);
      await tx.charge.update({
        where: { id: chargeId },
        data: { status: 'VOIDED', voidedAt: new Date() },
      });
      if (remaining.greaterThan(0))
        await tx.ledgerEntry.create({
          data: {
            organizationId,
            leaseId: row.leaseId,
            chargeId,
            type: 'CHARGE_ADJUSTMENT',
            credit: remaining,
            occurredAt: new Date(),
          },
        });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'CHARGE_VOIDED',
        entityType: 'Charge',
        entityId: chargeId,
        reason,
      });
      return { id: chargeId, status: 'VOIDED' };
    });
  }

  /**
   * Posts every due, not-yet-posted period for the organization's active
   * schedules up to `asOf` (default: today in the organization's time zone).
   * Idempotent: existing periods are skipped, and uniqueness is enforced by
   * the database, so concurrent runs cannot double-bill.
   */
  async runBilling(organizationId: string, actorUserId: string | null, asOfInput?: string) {
    const today = await this.today(organizationId);
    const asOf = asOfInput ?? today;
    parseDateOnly(asOf);
    if (asOf > today) throw new DomainError('INVALID_DATE', 400, 'Billing cannot run for a future date.');
    const schedules = await this.prisma.billingSchedule.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        startsOn: { lte: parseDateOnly(asOf) },
        lease: { status: 'ACTIVE' },
      },
    });
    const posted = await this.prisma.charge.findMany({
      where: {
        OR: [
          { billingScheduleId: { in: schedules.map((item) => item.id) } },
          {
            leaseId: { in: schedules.map((item) => item.leaseId) },
            type: 'RENT',
            status: 'POSTED',
            billingPeriod: { not: null },
          },
        ],
      },
      select: { billingScheduleId: true, leaseId: true, type: true, billingPeriod: true },
    });
    const bySchedule = new Set(posted.map((item) => `${item.billingScheduleId}|${item.billingPeriod}`));
    const rentByLease = new Set(
      posted.filter((item) => item.type === 'RENT').map((item) => `${item.leaseId}|${item.billingPeriod}`),
    );
    let created = 0;
    let skipped = 0;
    for (const schedule of schedules) {
      const periods = duePeriods(
        {
          startsOn: formatDateOnly(schedule.startsOn),
          endsOn: schedule.endsOn ? formatDateOnly(schedule.endsOn) : null,
          billingDay: schedule.billingDay,
          dueDay: schedule.dueDay,
        },
        asOf,
      );
      for (const period of periods) {
        if (
          bySchedule.has(`${schedule.id}|${period.period}`) ||
          (schedule.chargeType === 'RENT' && rentByLease.has(`${schedule.leaseId}|${period.period}`))
        ) {
          skipped++;
          continue;
        }
        try {
          await this.prisma.serializable((tx) =>
            postCharge(tx, {
              organizationId,
              leaseId: schedule.leaseId,
              billingScheduleId: schedule.id,
              type: schedule.chargeType,
              description: schedule.description,
              amount: schedule.amount,
              billingPeriod: period.period,
              dueDate: parseDateOnly(period.dueDate),
              actorUserId,
              auditAction: 'SCHEDULED_CHARGE_POSTED',
            }),
          );
          created++;
        } catch (error) {
          if (isUniqueViolation(error) || (error instanceof DomainError && error.code === 'CHARGE_EXISTS')) {
            skipped++;
            continue;
          }
          throw error;
        }
      }
    }
    return { asOf, period: periodOf(asOf), schedules: schedules.length, created, skipped };
  }

  async today(organizationId: string): Promise<string> {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return todayInZone(organization.timezone);
  }
}
