import type { PrismaService, Tx } from '../common/prisma.service.js';

/**
 * Every table holding a demo workspace's rows, children before parents, so no
 * foreign key (all RESTRICT towards the ledger) blocks the delete. Rows without
 * their own "organizationId" are reached through the parent named in the query.
 * `demo.e2e-spec` checks that every table with an "organizationId" column ends
 * up empty, so a new table that is missing here fails the suite.
 */
const DEMO_DELETE_ORDER: readonly string[] = [
  'DELETE FROM "PaymentNotice" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Receipt" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "LedgerEntry" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "PaymentReversal" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "DepositTransaction" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "DepositAccount" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "ChargeAdjustment" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "PaymentAllocation" WHERE "paymentId" IN (SELECT id FROM "Payment" WHERE "organizationId" = $1::uuid)',
  'DELETE FROM "Payment" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Charge" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "BillingSchedule" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "LeaseOccupant" WHERE "leaseId" IN (SELECT id FROM "Lease" WHERE "organizationId" = $1::uuid)',
  'DELETE FROM "MaintenanceRequest" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Expense" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "StaffInvitation" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Session" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Membership" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Lease" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "RentableSpace" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Unit" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Property" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "Tenant" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "DocumentRecord" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "StorageObject" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "AuditLog" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "IdempotencyKey" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "OutboxEvent" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "MailDelivery" WHERE "organizationId" = $1::uuid',
  'DELETE FROM "ReceiptSequence" WHERE "organizationId" = $1::uuid',
];

/**
 * Deletes a demo workspace, its rows, and the demo users that belonged only to it.
 * Refuses (returns false, deletes nothing) for any workspace that is not a demo.
 */
export async function deleteDemoOrganization(prisma: PrismaService, organizationId: string): Promise<boolean> {
  return prisma.$transaction(
    async (tx: Tx) => {
      const locked = await tx.$queryRaw<Array<{ demoExpiresAt: Date | null }>>`
        SELECT "demoExpiresAt" FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
      if (!locked[0] || locked[0].demoExpiresAt === null) return false;
      const members = await tx.membership.findMany({ where: { organizationId }, select: { userId: true } });
      for (const statement of DEMO_DELETE_ORDER) await tx.$executeRawUnsafe(statement, organizationId);
      await tx.$executeRaw`DELETE FROM "Organization" WHERE id = ${organizationId}::uuid AND "demoExpiresAt" IS NOT NULL`;
      const userIds = members.map((member) => member.userId);
      if (userIds.length)
        await tx.user.deleteMany({ where: { id: { in: userIds }, memberships: { none: {} } } });
      return true;
    },
    { timeout: 30_000 },
  );
}

/** Deletes every demo workspace whose time is up. Returns how many were deleted. */
export async function deleteExpiredDemos(prisma: PrismaService, now = new Date()): Promise<number> {
  const expired = await prisma.organization.findMany({
    where: { demoExpiresAt: { not: null, lte: now } },
    select: { id: true },
    take: 100,
  });
  let deleted = 0;
  for (const { id } of expired) if (await deleteDemoOrganization(prisma, id)) deleted += 1;
  return deleted;
}
