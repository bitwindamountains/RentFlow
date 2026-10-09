import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { addDays, dateOf, formatDateOnly, parseDateOnly, todayInZone } from '../common/dates.js';
import { DomainError } from '../common/errors.js';
import { formatMoney, ZERO } from '../common/money.js';
import { PrismaService } from '../common/prisma.service.js';
import { BalancesService } from '../billing/balances.service.js';

interface Range {
  from: string;
  to: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
  ) {}

  /** "What needs my attention?" — this month's position plus a 6-month trend. */
  async dashboard(organizationId: string) {
    const org = await this.organization(organizationId);
    const today = todayInZone(org.timezone);
    const monthStart = `${today.slice(0, 8)}01`;
    const monthEnd = addDays(dateOf(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1), -1);
    const trendStart = dateOf(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 6, 1);

    const [month] = await this.prisma.$queryRaw<
      Array<{ billed: Prisma.Decimal | null; collectedOnBilled: Prisma.Decimal | null }>
    >`
      SELECT SUM(c.amount - COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0)) AS billed,
             SUM(COALESCE((SELECT SUM(pa.amount) FROM "PaymentAllocation" pa JOIN "Payment" p ON p.id = pa."paymentId" AND p.status = 'POSTED' WHERE pa."chargeId" = c.id), 0)) AS "collectedOnBilled"
      FROM "Charge" c
      WHERE c."organizationId" = ${organizationId}::uuid AND c.status = 'POSTED'
        AND c."dueDate" BETWEEN ${monthStart}::date AND ${monthEnd}::date`;
    const [received] = await this.prisma.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT SUM(amount) AS total FROM "Payment"
      WHERE "organizationId" = ${organizationId}::uuid AND status = 'POSTED'
        AND ("paidAt" AT TIME ZONE ${org.timezone})::date BETWEEN ${monthStart}::date AND ${monthEnd}::date`;
    const trend = await this.prisma.$queryRaw<
      Array<{ month: string; billed: Prisma.Decimal | null; collected: Prisma.Decimal | null }>
    >`
      SELECT to_char(m, 'YYYY-MM') AS month,
        (SELECT SUM(c.amount - COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0))
           FROM "Charge" c WHERE c."organizationId" = ${organizationId}::uuid AND c.status = 'POSTED'
           AND date_trunc('month', c."dueDate") = m) AS billed,
        (SELECT SUM(p.amount) FROM "Payment" p WHERE p."organizationId" = ${organizationId}::uuid AND p.status = 'POSTED'
           AND date_trunc('month', (p."paidAt" AT TIME ZONE ${org.timezone})) = m) AS collected
      FROM generate_series(${trendStart}::date, ${monthStart}::date, interval '1 month') m
      ORDER BY m`;
    const [totals] = await this.prisma.$queryRaw<Array<{ outstanding: Prisma.Decimal | null; overdue: Prisma.Decimal | null }>>`
      SELECT SUM(o.outstanding) AS outstanding,
             SUM(o.outstanding) FILTER (WHERE o."dueDate" + o.grace < ${today}::date) AS overdue
      FROM (
        SELECT c."dueDate", l."gracePeriodDays" AS grace,
               c.amount
                 - COALESCE((SELECT SUM(pa.amount) FROM "PaymentAllocation" pa JOIN "Payment" p ON p.id = pa."paymentId" AND p.status = 'POSTED' WHERE pa."chargeId" = c.id), 0)
                 - COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0) AS outstanding
        FROM "Charge" c JOIN "Lease" l ON l.id = c."leaseId"
        WHERE c."organizationId" = ${organizationId}::uuid AND c.status = 'POSTED'
      ) o WHERE o.outstanding > 0`;
    const [spaces, occupied, activeLeases, expiring, openMaintenance, arrears] = await Promise.all([
      this.prisma.rentableSpace.count({ where: { organizationId } }),
      this.prisma.lease.findMany({
        where: { organizationId, status: 'ACTIVE' },
        distinct: ['rentableSpaceId'],
        select: { rentableSpaceId: true },
      }),
      this.prisma.lease.count({ where: { organizationId, status: 'ACTIVE' } }),
      this.prisma.lease.count({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { gte: parseDateOnly(today), lte: parseDateOnly(addDays(today, 30)) },
        },
      }),
      this.prisma.maintenanceRequest.count({
        where: { organizationId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      }),
      this.balances.arrears(organizationId, today, 5),
    ]);
    const billed = month?.billed ?? ZERO;
    const collectedOnBilled = month?.collectedOnBilled ?? ZERO;
    return {
      asOf: today,
      currency: org.currency,
      month: today.slice(0, 7),
      billedThisMonth: formatMoney(billed),
      collectedThisMonth: formatMoney(received?.total ?? ZERO),
      collectionRate: billed.isZero() ? null : Number(collectedOnBilled.div(billed).mul(100).toFixed(1)),
      // Same basis as collectionRate: cash applied to older arrears does not reduce this month's balance.
      remainingThisMonth: formatMoney(Prisma.Decimal.max(ZERO, billed.minus(collectedOnBilled))),
      outstanding: formatMoney(totals?.outstanding ?? ZERO),
      overdue: formatMoney(totals?.overdue ?? ZERO),
      activeLeases,
      occupiedUnits: occupied.length,
      totalUnits: spaces,
      occupancyRate: spaces ? Math.round((occupied.length / spaces) * 1000) / 10 : null,
      leasesEndingSoon: expiring,
      openMaintenance,
      topArrears: arrears,
      trend: trend.map((row) => ({
        month: row.month,
        billed: formatMoney(row.billed ?? ZERO),
        collected: formatMoney(row.collected ?? ZERO),
      })),
    };
  }

  async arrears(organizationId: string) {
    const org = await this.organization(organizationId);
    return this.balances.arrears(organizationId, todayInZone(org.timezone));
  }

  async reminders(organizationId: string) {
    const org = await this.organization(organizationId);
    const today = todayInZone(org.timezone);
    const [arrears, leases, maintenance, notices] = await Promise.all([
      this.balances.arrears(organizationId, today, 50),
      this.prisma.lease.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { gte: parseDateOnly(today), lte: parseDateOnly(addDays(today, 30)) },
        },
        include: { primaryTenant: { select: { firstName: true, lastName: true } } },
        orderBy: { endDate: 'asc' },
        take: 50,
      }),
      this.prisma.maintenanceRequest.findMany({
        where: {
          organizationId,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          OR: [{ priority: { in: ['HIGH', 'URGENT'] } }, { dueOn: { lte: parseDateOnly(today) } }],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: 50,
      }),
      this.prisma.paymentNotice.findMany({
        where: { organizationId, status: 'SUBMITTED' },
        include: { tenant: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    ]);
    return [
      ...notices.map((notice) => ({
        id: notice.id,
        type: 'PAYMENT_NOTICE',
        title: `${notice.tenant.firstName} ${notice.tenant.lastName} reported a payment`,
        detail: `${formatMoney(notice.amount)} · ${notice.method.replace('_', ' ').toLowerCase()} · paid ${formatDateOnly(notice.paidOn)}`,
        route: '/payments',
        severity: 'high',
        tenantId: notice.tenantId,
        amount: formatMoney(notice.amount),
      })),
      ...arrears.map((row) => ({
        id: row.leaseId,
        type: 'OVERDUE_BALANCE',
        title: row.tenantName,
        detail: `${row.overdue} overdue · ${row.daysOverdue} days · Unit ${row.unitNumber}`,
        route: `/tenants/${row.tenantId}`,
        severity: row.daysOverdue > 30 ? 'high' : 'medium',
        leaseId: row.leaseId,
        tenantId: row.tenantId,
        amount: row.overdue,
      })),
      ...leases.map((lease) => ({
        id: lease.id,
        type: 'LEASE_EXPIRY',
        title: `${lease.primaryTenant.firstName} ${lease.primaryTenant.lastName}`,
        detail: `Lease ends ${formatDateOnly(lease.endDate!)}`,
        route: '/leases',
        severity: 'medium',
      })),
      ...maintenance.map((item) => ({
        id: item.id,
        type: 'MAINTENANCE',
        title: item.title,
        detail: `${item.priority.toLowerCase()} priority · ${item.status.replace('_', ' ').toLowerCase()}`,
        route: '/maintenance',
        severity: item.priority === 'URGENT' ? 'high' : 'medium',
      })),
    ];
  }

  async financial(organizationId: string, input: Partial<Range>) {
    const org = await this.organization(organizationId);
    const range = this.range(input, todayInZone(org.timezone));
    const [charges] = await this.prisma.$queryRaw<Array<{ billed: Prisma.Decimal | null; adjusted: Prisma.Decimal | null; count: number }>>`
      SELECT SUM(c.amount) AS billed,
             SUM(COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0)) AS adjusted,
             COUNT(*)::int AS count
      FROM "Charge" c WHERE c."organizationId" = ${organizationId}::uuid AND c.status = 'POSTED'
        AND c."dueDate" BETWEEN ${range.from}::date AND ${range.to}::date`;
    const [payments] = await this.prisma.$queryRaw<Array<{ total: Prisma.Decimal | null; count: number }>>`
      SELECT SUM(amount) AS total, COUNT(*)::int AS count FROM "Payment"
      WHERE "organizationId" = ${organizationId}::uuid AND status = 'POSTED'
        AND ("paidAt" AT TIME ZONE ${org.timezone})::date BETWEEN ${range.from}::date AND ${range.to}::date`;
    const expenses = await this.prisma.expense.aggregate({
      where: {
        organizationId,
        voidedAt: null,
        incurredOn: { gte: parseDateOnly(range.from), lte: parseDateOnly(range.to) },
      },
      _sum: { amount: true },
      _count: true,
    });
    const byProperty = await this.prisma.$queryRaw<
      Array<{ propertyId: string; name: string; collected: Prisma.Decimal | null; expenses: Prisma.Decimal | null }>
    >`
      SELECT pr.id AS "propertyId", pr.name,
        (SELECT SUM(p.amount) FROM "Payment" p
           JOIN "Lease" l ON l.id = p."leaseId" JOIN "RentableSpace" s ON s.id = l."rentableSpaceId" JOIN "Unit" u ON u.id = s."unitId"
           WHERE u."propertyId" = pr.id AND p.status = 'POSTED'
             AND (p."paidAt" AT TIME ZONE ${org.timezone})::date BETWEEN ${range.from}::date AND ${range.to}::date) AS collected,
        (SELECT SUM(e.amount) FROM "Expense" e
           WHERE e."propertyId" = pr.id AND e."voidedAt" IS NULL
             AND e."incurredOn" BETWEEN ${range.from}::date AND ${range.to}::date) AS expenses
      FROM "Property" pr WHERE pr."organizationId" = ${organizationId}::uuid
      ORDER BY pr.name`;
    const billed = (charges?.billed ?? ZERO).minus(charges?.adjusted ?? ZERO);
    const collected = payments?.total ?? ZERO;
    const spent = expenses._sum.amount ?? ZERO;
    return {
      ...range,
      currency: org.currency,
      billed: formatMoney(billed),
      adjustments: formatMoney(charges?.adjusted ?? ZERO),
      collected: formatMoney(collected),
      expenses: formatMoney(spent),
      netCash: formatMoney(collected.minus(spent)),
      chargeCount: charges?.count ?? 0,
      paymentCount: payments?.count ?? 0,
      expenseCount: expenses._count,
      properties: byProperty.map((row) => {
        const income = row.collected ?? ZERO;
        const cost = row.expenses ?? ZERO;
        return {
          propertyId: row.propertyId,
          name: row.name,
          collected: formatMoney(income),
          expenses: formatMoney(cost),
          net: formatMoney(income.minus(cost)),
        };
      }),
    };
  }

  async transactionsCsv(organizationId: string, input: Partial<Range>) {
    const org = await this.organization(organizationId);
    const range = this.range(input, todayInZone(org.timezone));
    const [payments, expenses] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          organizationId,
          paidAt: {
            gte: new Date(`${addDays(range.from, -1)}T00:00:00Z`),
            lte: new Date(`${addDays(range.to, 1)}T23:59:59Z`),
          },
        },
        include: { tenant: true, receipts: { take: 1, orderBy: { issuedAt: 'desc' } } },
        orderBy: { paidAt: 'asc' },
      }),
      this.prisma.expense.findMany({
        where: { organizationId, incurredOn: { gte: parseDateOnly(range.from), lte: parseDateOnly(range.to) } },
        include: { property: { select: { name: true } } },
        orderBy: { incurredOn: 'asc' },
      }),
    ]);
    const lines = [['type', 'date', 'reference', 'party', 'description', 'amount', 'currency', 'status'].join(',')];
    for (const row of payments) {
      const localDate = todayInZone(org.timezone, row.paidAt);
      if (localDate < range.from || localDate > range.to) continue;
      lines.push(
        csvRow([
          'payment',
          localDate,
          row.receipts[0]?.number ?? row.referenceNumber ?? '',
          `${row.tenant.firstName} ${row.tenant.lastName}`,
          `${row.method}${row.referenceNumber ? ` ${row.referenceNumber}` : ''}`,
          formatMoney(row.amount),
          org.currency,
          row.status,
        ]),
      );
    }
    for (const row of expenses)
      lines.push(
        csvRow([
          'expense',
          formatDateOnly(row.incurredOn),
          row.reference ?? '',
          row.vendor ?? row.property?.name ?? '',
          row.description,
          `-${formatMoney(row.amount)}`,
          org.currency,
          row.voidedAt ? 'VOIDED' : 'POSTED',
        ]),
      );
    return { csv: `﻿${lines.join('\r\n')}\r\n`, range };
  }

  async auditLog(organizationId: string, query: { entityType?: string; entityId?: string; limit?: number }) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId,
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
      },
      include: { actor: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 100,
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actor: row.actor?.displayName ?? 'System',
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private range(input: Partial<Range>, today: string): Range {
    const to = input.to ?? today;
    const from = input.from ?? `${today.slice(0, 4)}-01-01`;
    parseDateOnly(from);
    parseDateOnly(to);
    if (from > to) throw new DomainError('INVALID_DATE', 400, 'The start date must be before the end date.');
    return { from, to };
  }

  private organization(id: string) {
    return this.prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { timezone: true, currency: true },
    });
  }
}

/** RFC 4180 quoting with spreadsheet formula-injection protection. */
export function csvRow(values: string[]): string {
  return values
    .map((value) => {
      const text = String(value);
      const safe = /^[\s]*[=+\-@\t\r]/.test(text) && !/^-\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    })
    .join(',');
}
