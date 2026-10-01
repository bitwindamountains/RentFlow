import { Injectable } from '@nestjs/common';
import { Prisma, type DepositTransactionType, type PaymentMethod } from '@prisma/client';
import { audit } from '../common/audit.js';
import { todayInZone } from '../common/dates.js';
import { DomainError, notFound } from '../common/errors.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { formatMoney, parseMoney, sumMoney, ZERO } from '../common/money.js';
import { PrismaService } from '../common/prisma.service.js';
import { decodeCursor, encodeCursor, type Page } from '../common/validation.js';
import { BalancesService } from '../billing/balances.service.js';

export interface PaymentInput {
  tenantId: string;
  leaseId: string;
  amount: string;
  method: PaymentMethod;
  referenceNumber?: string;
  notes?: string;
  paidAt: string;
  allocations: Array<{ chargeId: string; amount: string }>;
}

const paymentInclude = {
  allocations: true,
  receipts: { orderBy: { issuedAt: 'desc' }, take: 1 },
  tenant: { select: { firstName: true, lastName: true } },
  lease: { select: { rentableSpace: { select: { unit: { select: { number: true } } } } } },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

function paymentView(payment: PaymentRow) {
  return {
    id: payment.id,
    tenantId: payment.tenantId,
    tenantName: `${payment.tenant.firstName} ${payment.tenant.lastName}`,
    leaseId: payment.leaseId,
    unitNumber: payment.lease?.rentableSpace.unit.number ?? null,
    amount: formatMoney(payment.amount),
    unallocated: formatMoney(payment.amount.minus(sumMoney(payment.allocations.map((a) => a.amount)))),
    method: payment.method,
    referenceNumber: payment.referenceNumber,
    paidAt: payment.paidAt.toISOString(),
    status: payment.status,
    receiptNumber: payment.receipts[0]?.number ?? null,
    createdAt: payment.createdAt.toISOString(),
    allocations: payment.allocations.map((item) => ({
      chargeId: item.chargeId,
      amount: formatMoney(item.amount),
    })),
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(
    organizationId: string,
    query: { cursor?: string; limit?: number; q?: string; status?: 'POSTED' | 'REVERSED'; tenantId?: string },
  ): Promise<Page<ReturnType<typeof paymentView>>> {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const rows = await this.prisma.payment.findMany({
      where: {
        organizationId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.tenantId ? { tenantId: query.tenantId } : {}),
        AND: [
          q
            ? {
                OR: [
                  { referenceNumber: { contains: q, mode: 'insensitive' } },
                  { receipts: { some: { number: { contains: q, mode: 'insensitive' } } } },
                  { tenant: { firstName: { contains: q, mode: 'insensitive' } } },
                  { tenant: { lastName: { contains: q, mode: 'insensitive' } } },
                ],
              }
            : {},
          cursor
            ? {
                OR: [
                  { paidAt: { lt: new Date(cursor.sortValue) } },
                  { paidAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      include: paymentInclude,
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map(paymentView);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.paidAt, last.id) : null };
  }

  /** Active leases with what is owed: the "who is paying?" picker. */
  async collectionOptions(organizationId: string) {
    const rows = await this.balances.leaseOutstanding(organizationId);
    return rows.map((row) => ({
      leaseId: row.leaseId,
      tenantId: row.tenantId,
      tenantName: `${row.firstName} ${row.lastName}`,
      unitNumber: row.unitNumber,
      propertyName: row.propertyName,
      monthlyRent: formatMoney(row.monthlyRent),
      outstanding: formatMoney(row.outstanding),
      balance: formatMoney(row.balance),
    }));
  }

  async create(organizationId: string, actorUserId: string, input: PaymentInput, key: string) {
    const amount = parseMoney(input.amount);
    const paidAt = new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60_000)
      throw new DomainError('FUTURE_PAYMENT_DATE', 422);
    if (paidAt.getUTCFullYear() < 2000) throw new DomainError('INVALID_DATE');
    const allocations = input.allocations.map((item) => ({ chargeId: item.chargeId, amount: parseMoney(item.amount) }));
    if (new Set(allocations.map((item) => item.chargeId)).size !== allocations.length)
      throw new DomainError('INVALID_ALLOCATION', 422, 'Each charge can appear only once in a payment.');
    if (sumMoney(allocations.map((item) => item.amount)).greaterThan(amount))
      throw new DomainError('ALLOCATION_EXCEEDS_PAYMENT', 422);

    return this.idempotency.execute(
      { organizationId, key, operation: 'CREATE_PAYMENT' },
      input,
      async (tx) => {
        const lease = await tx.lease.findFirst({
          where: { id: input.leaseId, organizationId, primaryTenantId: input.tenantId },
          include: { organization: { select: { receiptPrefix: true, timezone: true } } },
        });
        if (!lease) throw notFound('LEASE_NOT_FOUND');
        if (allocations.length) {
          const open = await this.balances.charges(
            organizationId,
            { chargeIds: allocations.map((item) => item.chargeId), leaseId: lease.id },
            tx,
          );
          const byId = new Map(open.map((row) => [row.id, row]));
          for (const allocation of allocations) {
            const charge = byId.get(allocation.chargeId);
            if (!charge || charge.status !== 'POSTED' || allocation.amount.greaterThan(charge.outstanding))
              throw new DomainError('INVALID_ALLOCATION', 422);
          }
        }
        const sequence = await tx.receiptSequence.update({
          where: { organizationId },
          data: { nextNumber: { increment: 1 } },
        });
        const year = todayInZone(lease.organization.timezone, paidAt).slice(0, 4);
        const receiptNumber = `${lease.organization.receiptPrefix}-${year}-${String(sequence.nextNumber - 1n).padStart(6, '0')}`;
        const payment = await tx.payment.create({
          data: {
            organizationId,
            tenantId: input.tenantId,
            leaseId: lease.id,
            amount,
            method: input.method,
            referenceNumber: input.referenceNumber?.trim() || undefined,
            notes: input.notes?.trim() || undefined,
            paidAt,
            status: 'POSTED',
            recordedBy: actorUserId,
            postedAt: new Date(),
            allocations: { create: allocations },
            receipts: { create: { organizationId, number: receiptNumber, issuedAt: new Date() } },
          },
          include: paymentInclude,
        });
        await tx.ledgerEntry.create({
          data: {
            organizationId,
            leaseId: lease.id,
            paymentId: payment.id,
            type: 'PAYMENT',
            credit: amount,
            occurredAt: paidAt,
          },
        });
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'PAYMENT_POSTED',
          entityType: 'Payment',
          entityId: payment.id,
          after: { amount, method: input.method, paidAt, receiptNumber, allocations },
        });
        return paymentView(payment);
      },
    );
  }

  async receipt(organizationId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, organizationId },
      include: {
        organization: { select: { name: true, currency: true, timezone: true } },
        tenant: { select: { firstName: true, lastName: true } },
        receipts: { orderBy: { issuedAt: 'desc' }, take: 1 },
        reversals: { select: { reason: true, createdAt: true } },
        lease: {
          select: {
            rentableSpace: { select: { unit: { select: { number: true, property: { select: { name: true, addressLine1: true, city: true } } } } } },
          },
        },
        allocations: { include: { charge: { select: { description: true, billingPeriod: true, dueDate: true } } } },
      },
    });
    if (!payment) throw notFound('PAYMENT_NOT_FOUND');
    const receipt = payment.receipts[0];
    const unit = payment.lease?.rentableSpace.unit;
    const allocated = sumMoney(payment.allocations.map((item) => item.amount));
    return {
      paymentId: payment.id,
      receiptNumber: receipt?.number ?? null,
      issuedAt: receipt?.issuedAt.toISOString() ?? null,
      voided: Boolean(receipt?.voidedAt) || payment.status !== 'POSTED',
      voidReason: payment.reversals[0]?.reason ?? null,
      organization: payment.organization,
      tenantName: `${payment.tenant.firstName} ${payment.tenant.lastName}`,
      property: unit ? { name: unit.property.name, address: `${unit.property.addressLine1}, ${unit.property.city}`, unit: unit.number } : null,
      amount: formatMoney(payment.amount),
      method: payment.method,
      referenceNumber: payment.referenceNumber,
      paidAt: payment.paidAt.toISOString(),
      lines: payment.allocations.map((item) => ({
        description: item.charge.description,
        billingPeriod: item.charge.billingPeriod,
        amount: formatMoney(item.amount),
      })),
      credit: formatMoney(payment.amount.minus(allocated)),
    };
  }

  async reverse(organizationId: string, actorUserId: string, paymentId: string, reason: string) {
    return this.prisma.serializable(async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, organizationId, status: 'POSTED' } });
      if (!payment || !payment.leaseId) throw notFound('PAYMENT_NOT_FOUND');
      const reversal = await tx.paymentReversal.create({
        data: { organizationId, paymentId, reason: reason.trim(), reversedBy: actorUserId },
      });
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'REVERSED' } });
      await tx.receipt.updateMany({ where: { paymentId: payment.id, voidedAt: null }, data: { voidedAt: new Date() } });
      await tx.ledgerEntry.create({
        data: {
          organizationId,
          leaseId: payment.leaseId,
          paymentId: payment.id,
          type: 'PAYMENT_REVERSAL',
          debit: payment.amount,
          occurredAt: new Date(),
        },
      });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'PAYMENT_REVERSED',
        entityType: 'Payment',
        entityId: payment.id,
        reason,
        after: reversal,
      });
      return { id: reversal.id, paymentId, amount: formatMoney(payment.amount), status: 'REVERSED' };
    });
  }

  async listDeposits(organizationId: string) {
    const rows = await this.prisma.depositAccount.findMany({
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
        transactions: { orderBy: { occurredAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      leaseId: row.leaseId,
      leaseStatus: row.lease.status,
      tenantName: `${row.lease.primaryTenant.firstName} ${row.lease.primaryTenant.lastName}`,
      unitNumber: row.lease.rentableSpace.unit.number,
      requiredAmount: formatMoney(row.requiredAmount),
      balance: formatMoney(depositBalance(row.transactions)),
      transactions: row.transactions.map((item) => ({
        id: item.id,
        type: item.type,
        amount: formatMoney(item.amount),
        reason: item.reason,
        occurredAt: item.occurredAt.toISOString(),
      })),
    }));
  }

  async recordDeposit(
    organizationId: string,
    actorUserId: string,
    leaseId: string,
    input: { type: DepositTransactionType; amount: string; requiredAmount?: string; reason?: string; occurredAt?: string },
    key: string,
  ) {
    const amount = parseMoney(input.amount);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 5 * 60_000)
      throw new DomainError('INVALID_DATE');
    if (input.type !== 'RECEIPT' && !input.reason?.trim())
      throw new DomainError('INVALID_DEPOSIT', 422, 'A reason is required for deductions, refunds, and adjustments.');
    return this.idempotency.execute(
      { organizationId, key, operation: 'DEPOSIT' },
      { leaseId, ...input },
      async (tx) => {
        const lease = await tx.lease.findFirst({ where: { id: leaseId, organizationId } });
        if (!lease) throw notFound('LEASE_NOT_FOUND');
        const account = await tx.depositAccount.upsert({
          where: { leaseId },
          update: {},
          create: {
            organizationId,
            leaseId,
            requiredAmount: input.requiredAmount ? parseMoney(input.requiredAmount, { allowZero: true }) : lease.depositRequired,
          },
          include: { transactions: true },
        });
        if (['DEDUCTION', 'REFUND'].includes(input.type) && amount.greaterThan(depositBalance(account.transactions)))
          throw new DomainError('INVALID_DEPOSIT', 422);
        const transaction = await tx.depositTransaction.create({
          data: {
            organizationId,
            depositAccountId: account.id,
            type: input.type,
            amount,
            reason: input.reason?.trim(),
            recordedBy: actorUserId,
            occurredAt,
          },
        });
        await audit(tx, {
          organizationId,
          actorUserId,
          action: `DEPOSIT_${input.type}`,
          entityType: 'DepositTransaction',
          entityId: transaction.id,
          after: transaction,
        });
        return {
          id: transaction.id,
          leaseId,
          type: transaction.type,
          amount: formatMoney(transaction.amount),
          occurredAt: transaction.occurredAt.toISOString(),
        };
      },
    );
  }
}

function depositBalance(transactions: Array<{ type: DepositTransactionType; amount: Prisma.Decimal }>) {
  return transactions.reduce(
    (sum, item) => (item.type === 'RECEIPT' || item.type === 'ADJUSTMENT' ? sum.plus(item.amount) : sum.minus(item.amount)),
    ZERO,
  );
}
