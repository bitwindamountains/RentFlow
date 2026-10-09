import type { ChargeType, Prisma } from '@prisma/client';
import { audit } from '../common/audit.js';
import { DomainError } from '../common/errors.js';
import type { Tx } from '../common/prisma.service.js';
import { applyLeaseCredit } from './credit.js';

export interface PostChargeInput {
  organizationId: string;
  leaseId: string;
  type: ChargeType;
  description: string;
  amount: Prisma.Decimal;
  dueDate: Date;
  billingPeriod?: string | null;
  billingScheduleId?: string | null;
  actorUserId?: string | null;
  auditAction?: string;
}

/**
 * The single place a charge is posted: charge row, ledger debit, and audit
 * entry in the caller's transaction. Rent is unique per lease and billing
 * period across manual and scheduled charges (checked under SERIALIZABLE).
 */
export async function postCharge(tx: Tx, input: PostChargeInput) {
  if (input.type === 'RENT' && input.billingPeriod) {
    const duplicate = await tx.charge.findFirst({
      where: {
        leaseId: input.leaseId,
        type: 'RENT',
        billingPeriod: input.billingPeriod,
        status: 'POSTED',
      },
      select: { id: true },
    });
    if (duplicate) throw new DomainError('CHARGE_EXISTS', 409);
  }
  const now = new Date();
  const charge = await tx.charge.create({
    data: {
      organizationId: input.organizationId,
      leaseId: input.leaseId,
      billingScheduleId: input.billingScheduleId ?? undefined,
      type: input.type,
      description: input.description.trim(),
      amount: input.amount,
      billingPeriod: input.billingPeriod ?? undefined,
      dueDate: input.dueDate,
      status: 'POSTED',
      postedAt: now,
    },
  });
  await tx.ledgerEntry.create({
    data: {
      organizationId: input.organizationId,
      leaseId: input.leaseId,
      chargeId: charge.id,
      type: 'CHARGE',
      debit: charge.amount,
      occurredAt: now,
    },
  });
  await audit(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.auditAction ?? 'CHARGE_POSTED',
    entityType: 'Charge',
    entityId: charge.id,
    after: charge,
  });
  await applyLeaseCredit(tx, input.organizationId, input.leaseId, input.actorUserId);
  return charge;
}
