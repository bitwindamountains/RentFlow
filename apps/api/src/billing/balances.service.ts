import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatDateOnly } from '../common/dates.js';
import { formatMoney, ZERO } from '../common/money.js';
import { PrismaService, type Tx } from '../common/prisma.service.js';

export interface ChargeBalanceRow {
  id: string;
  leaseId: string;
  type: string;
  description: string;
  amount: Prisma.Decimal;
  billingPeriod: string | null;
  dueDate: Date;
  status: string;
  createdAt: Date;
  paid: Prisma.Decimal;
  adjusted: Prisma.Decimal;
  outstanding: Prisma.Decimal;
  tenantId: string;
  firstName: string;
  lastName: string;
  unitNumber: string;
  propertyName: string;
  gracePeriodDays: number;
}

export interface ChargeFilter {
  status?: 'open' | 'overdue' | 'all';
  leaseId?: string;
  tenantId?: string;
  chargeIds?: string[];
  today?: string;
  q?: string;
  before?: { dueDate: string; id: string };
  limit?: number;
}

/**
 * Balances are always derived from posted allocations and adjustments in
 * SQL, never by loading every row into the application.
 */
@Injectable()
export class BalancesService {
  constructor(private readonly prisma: PrismaService) {}

  async charges(organizationId: string, filter: ChargeFilter = {}, db: Tx | PrismaService = this.prisma) {
    const conditions: Prisma.Sql[] = [Prisma.sql`c."organizationId" = ${organizationId}::uuid`];
    if (filter.status && filter.status !== 'all') conditions.push(Prisma.sql`c.status = 'POSTED'`);
    if (filter.leaseId) conditions.push(Prisma.sql`c."leaseId" = ${filter.leaseId}::uuid`);
    if (filter.tenantId) conditions.push(Prisma.sql`l."primaryTenantId" = ${filter.tenantId}::uuid`);
    if (filter.chargeIds) conditions.push(Prisma.sql`c.id = ANY(${filter.chargeIds}::uuid[])`);
    if (filter.q) {
      const like = `%${filter.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conditions.push(
        Prisma.sql`(c.description ILIKE ${like} OR t."firstName" || ' ' || t."lastName" ILIKE ${like} OR u.number ILIKE ${like})`,
      );
    }
    if (filter.before)
      conditions.push(
        Prisma.sql`(c."dueDate", c.id) < (${filter.before.dueDate}::date, ${filter.before.id}::uuid)`,
      );
    const outer: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (filter.status === 'open' || filter.status === 'overdue') outer.push(Prisma.sql`cb.outstanding > 0`);
    if (filter.status === 'overdue')
      outer.push(Prisma.sql`cb."dueDate" + cb."gracePeriodDays" < ${filter.today ?? formatDateOnly(new Date())}::date`);
    const limit = filter.limit ? Prisma.sql`LIMIT ${filter.limit}` : Prisma.empty;
    return db.$queryRaw<ChargeBalanceRow[]>`
      SELECT * FROM (
        SELECT c.id, c."leaseId", c.type::text AS type, c.description, c.amount, c."billingPeriod",
               c."dueDate", c.status::text AS status, c."createdAt",
               paid.amount AS paid, adj.amount AS adjusted,
               CASE WHEN c.status = 'POSTED' THEN c.amount - paid.amount - adj.amount ELSE 0 END AS outstanding,
               t.id AS "tenantId", t."firstName", t."lastName",
               u.number AS "unitNumber", pr.name AS "propertyName", l."gracePeriodDays"
        FROM "Charge" c
        JOIN "Lease" l ON l.id = c."leaseId"
        JOIN "Tenant" t ON t.id = l."primaryTenantId"
        JOIN "RentableSpace" s ON s.id = l."rentableSpaceId"
        JOIN "Unit" u ON u.id = s."unitId"
        JOIN "Property" pr ON pr.id = u."propertyId"
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(pa.amount), 0) AS amount
          FROM "PaymentAllocation" pa JOIN "Payment" p ON p.id = pa."paymentId" AND p.status = 'POSTED'
          WHERE pa."chargeId" = c.id
        ) paid
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(a.amount), 0) AS amount FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id
        ) adj
        WHERE ${Prisma.join(conditions, ' AND ')}
      ) cb
      WHERE ${Prisma.join(outer, ' AND ')}
      ORDER BY cb."dueDate" DESC, cb.id DESC
      ${limit}`;
  }

  /** Ledger balance per tenant (charges − payments − credits + reversals). */
  async tenantBalances(organizationId: string, tenantIds?: string[]): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.$queryRaw<Array<{ tenantId: string; balance: Prisma.Decimal }>>`
      SELECT l."primaryTenantId" AS "tenantId", SUM(e.debit - e.credit) AS balance
      FROM "LedgerEntry" e JOIN "Lease" l ON l.id = e."leaseId"
      WHERE e."organizationId" = ${organizationId}::uuid
        ${tenantIds ? Prisma.sql`AND l."primaryTenantId" = ANY(${tenantIds}::uuid[])` : Prisma.empty}
      GROUP BY l."primaryTenantId"`;
    return new Map(rows.map((row) => [row.tenantId, row.balance]));
  }

  /** Active leases and ended leases still requiring settlement. */
  async leaseOutstanding(organizationId: string) {
    return this.prisma.$queryRaw<
      Array<{
        leaseId: string;
        leaseStatus: string;
        tenantId: string;
        firstName: string;
        lastName: string;
        unitNumber: string;
        propertyName: string;
        monthlyRent: Prisma.Decimal;
        outstanding: Prisma.Decimal;
        balance: Prisma.Decimal;
      }>
    >`
      SELECT * FROM (SELECT l.id AS "leaseId", l.status::text AS "leaseStatus", t.id AS "tenantId", t."firstName", t."lastName",
             u.number AS "unitNumber", pr.name AS "propertyName", l."monthlyRent",
             COALESCE((
               SELECT SUM(c.amount
                 - COALESCE((SELECT SUM(pa.amount) FROM "PaymentAllocation" pa JOIN "Payment" p ON p.id = pa."paymentId" AND p.status = 'POSTED' WHERE pa."chargeId" = c.id), 0)
                 - COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0))
               FROM "Charge" c WHERE c."leaseId" = l.id AND c.status = 'POSTED'), 0) AS outstanding,
             COALESCE((SELECT SUM(e.debit - e.credit) FROM "LedgerEntry" e WHERE e."leaseId" = l.id), 0) AS balance
      FROM "Lease" l
      JOIN "Tenant" t ON t.id = l."primaryTenantId"
      JOIN "RentableSpace" s ON s.id = l."rentableSpaceId"
      JOIN "Unit" u ON u.id = s."unitId"
      JOIN "Property" pr ON pr.id = u."propertyId"
      WHERE l."organizationId" = ${organizationId}::uuid AND l.status IN ('ACTIVE', 'EXPIRED', 'TERMINATED')) options
      WHERE "leaseStatus" = 'ACTIVE' OR outstanding > 0
      ORDER BY "lastName", "firstName", "unitNumber"`;
  }

  /** Overdue balances grouped by lease with aging buckets (days past due). */
  async arrears(organizationId: string, today: string, limit = 200) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        leaseId: string;
        tenantId: string;
        firstName: string;
        lastName: string;
        phone: string | null;
        unitNumber: string;
        propertyName: string;
        overdue: Prisma.Decimal;
        oldestDueDate: Date;
        chargeCount: number;
        d0_30: Prisma.Decimal;
        d31_60: Prisma.Decimal;
        d61_90: Prisma.Decimal;
        d90plus: Prisma.Decimal;
      }>
    >`
      WITH open AS (
        SELECT c."leaseId", c."dueDate",
               c.amount
                 - COALESCE((SELECT SUM(pa.amount) FROM "PaymentAllocation" pa JOIN "Payment" p ON p.id = pa."paymentId" AND p.status = 'POSTED' WHERE pa."chargeId" = c.id), 0)
                 - COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0) AS outstanding,
               (${today}::date - c."dueDate") AS age
        FROM "Charge" c JOIN "Lease" l ON l.id = c."leaseId"
        WHERE c."organizationId" = ${organizationId}::uuid AND c.status = 'POSTED'
          AND c."dueDate" + l."gracePeriodDays" < ${today}::date
      )
      SELECT o."leaseId", t.id AS "tenantId", t."firstName", t."lastName", t.phone,
             u.number AS "unitNumber", pr.name AS "propertyName",
             SUM(o.outstanding) AS overdue, MIN(o."dueDate") AS "oldestDueDate",
             COUNT(*)::int AS "chargeCount",
             SUM(o.outstanding) FILTER (WHERE o.age <= 30) AS d0_30,
             SUM(o.outstanding) FILTER (WHERE o.age BETWEEN 31 AND 60) AS d31_60,
             SUM(o.outstanding) FILTER (WHERE o.age BETWEEN 61 AND 90) AS d61_90,
             SUM(o.outstanding) FILTER (WHERE o.age > 90) AS d90plus
      FROM open o
      JOIN "Lease" l ON l.id = o."leaseId"
      JOIN "Tenant" t ON t.id = l."primaryTenantId"
      JOIN "RentableSpace" s ON s.id = l."rentableSpaceId"
      JOIN "Unit" u ON u.id = s."unitId"
      JOIN "Property" pr ON pr.id = u."propertyId"
      WHERE o.outstanding > 0
      GROUP BY o."leaseId", t.id, u.number, pr.name
      ORDER BY MIN(o."dueDate") ASC, SUM(o.outstanding) DESC
      LIMIT ${limit}`;
    return rows.map((row) => ({
      leaseId: row.leaseId,
      tenantId: row.tenantId,
      tenantName: `${row.firstName} ${row.lastName}`,
      phone: row.phone,
      unitNumber: row.unitNumber,
      propertyName: row.propertyName,
      overdue: formatMoney(row.overdue),
      oldestDueDate: formatDateOnly(row.oldestDueDate),
      daysOverdue: Math.round(
        (Date.parse(`${today}T00:00:00Z`) - row.oldestDueDate.getTime()) / 86_400_000,
      ),
      chargeCount: row.chargeCount,
      aging: {
        current: formatMoney(row.d0_30 ?? ZERO),
        days31to60: formatMoney(row.d31_60 ?? ZERO),
        days61to90: formatMoney(row.d61_90 ?? ZERO),
        over90: formatMoney(row.d90plus ?? ZERO),
      },
    }));
  }
}

export function chargeView(row: ChargeBalanceRow) {
  return {
    id: row.id,
    leaseId: row.leaseId,
    tenantId: row.tenantId,
    tenantName: `${row.firstName} ${row.lastName}`,
    unitNumber: row.unitNumber,
    propertyName: row.propertyName,
    type: row.type,
    description: row.description,
    amount: formatMoney(row.amount),
    paid: formatMoney(row.paid),
    adjusted: formatMoney(row.adjusted),
    outstanding: formatMoney(row.outstanding),
    billingPeriod: row.billingPeriod,
    dueDate: formatDateOnly(row.dueDate),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
