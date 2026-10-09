import { audit } from '../common/audit.js';
import { formatMoney, sumMoney } from '../common/money.js';
import type { Tx } from '../common/prisma.service.js';

/** Allocate posted credit oldest-first without changing payment totals or posting cash again.
 * Call inside a serializable transaction: allocation and reversal must not race.
 */
export async function applyLeaseCredit(tx: Tx, organizationId: string, leaseId: string, actorUserId?: string | null) {
  const payments = await tx.payment.findMany({
    where: { organizationId, leaseId, status: 'POSTED' },
    include: { allocations: true },
    orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
  });
  const credits = payments.map(payment => ({
    payment, remaining: payment.amount.minus(sumMoney(payment.allocations.map(a => a.amount))),
  })).filter(item => item.remaining.greaterThan(0));
  if (!credits.length) return;
  const charges = await tx.charge.findMany({
    where: { organizationId, leaseId, status: 'POSTED' },
    include: { allocations: { where: { payment: { status: 'POSTED' } } }, adjustments: true },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
  });
  for (const charge of charges) {
    let owed = charge.amount.minus(sumMoney(charge.allocations.map(a => a.amount))).minus(sumMoney(charge.adjustments.map(a => a.amount)));
    for (const credit of credits) {
      if (!owed.greaterThan(0)) break;
      if (!credit.remaining.greaterThan(0)) continue;
      const amount = credit.remaining.lessThan(owed) ? credit.remaining : owed;
      await tx.paymentAllocation.upsert({
        where: { paymentId_chargeId: { paymentId: credit.payment.id, chargeId: charge.id } },
        create: { paymentId: credit.payment.id, chargeId: charge.id, amount },
        update: { amount: { increment: amount } },
      });
      await audit(tx, { organizationId, actorUserId, action: 'PAYMENT_CREDIT_APPLIED', entityType: 'Payment', entityId: credit.payment.id,
        after: { chargeId: charge.id, amount: formatMoney(amount) } });
      credit.remaining = credit.remaining.minus(amount);
      owed = owed.minus(amount);
    }
  }
}
