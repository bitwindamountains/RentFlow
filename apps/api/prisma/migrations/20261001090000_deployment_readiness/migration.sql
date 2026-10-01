-- CreateEnum
CREATE TYPE "UserTokenType" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFICATION');

-- AlterTable
ALTER TABLE "DocumentRecord" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "userAgent" TEXT;

-- CreateTable
CREATE TABLE "UserToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "UserTokenType" NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLock" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "lockedUntil" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobLock_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserToken_tokenHash_key" ON "UserToken"("tokenHash");

-- CreateIndex
CREATE INDEX "UserToken_userId_type_idx" ON "UserToken"("userId", "type");

-- CreateIndex
CREATE INDEX "UserToken_expiresAt_idx" ON "UserToken"("expiresAt");

-- CreateIndex
CREATE INDEX "BillingSchedule_leaseId_idx" ON "BillingSchedule"("leaseId");

-- CreateIndex
CREATE INDEX "Charge_leaseId_status_idx" ON "Charge"("leaseId", "status");

-- CreateIndex
CREATE INDEX "ChargeAdjustment_chargeId_idx" ON "ChargeAdjustment"("chargeId");

-- CreateIndex
CREATE INDEX "DepositTransaction_depositAccountId_idx" ON "DepositTransaction"("depositAccountId");

-- CreateIndex
CREATE INDEX "Lease_primaryTenantId_idx" ON "Lease"("primaryTenantId");

-- CreateIndex
CREATE INDEX "LeaseOccupant_tenantId_idx" ON "LeaseOccupant"("tenantId");

-- CreateIndex
CREATE INDEX "LedgerEntry_chargeId_idx" ON "LedgerEntry"("chargeId");

-- CreateIndex
CREATE INDEX "LedgerEntry_paymentId_idx" ON "LedgerEntry"("paymentId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_idx" ON "Payment"("tenantId");

-- CreateIndex
CREATE INDEX "Payment_leaseId_idx" ON "Payment"("leaseId");

-- AddForeignKey
ALTER TABLE "UserToken" ADD CONSTRAINT "UserToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentableSpace" ADD CONSTRAINT "RentableSpace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSchedule" ADD CONSTRAINT "BillingSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeAdjustment" ADD CONSTRAINT "ChargeAdjustment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositTransaction" ADD CONSTRAINT "DepositTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Financial and scheduling invariants enforced by the database itself.
-- ---------------------------------------------------------------------------
ALTER TABLE "Charge"             ADD CONSTRAINT "Charge_amount_positive"             CHECK ("amount" > 0);
ALTER TABLE "Payment"            ADD CONSTRAINT "Payment_amount_positive"            CHECK ("amount" > 0);
ALTER TABLE "PaymentAllocation"  ADD CONSTRAINT "PaymentAllocation_amount_positive"  CHECK ("amount" > 0);
ALTER TABLE "ChargeAdjustment"   ADD CONSTRAINT "ChargeAdjustment_amount_positive"   CHECK ("amount" > 0);
ALTER TABLE "Expense"            ADD CONSTRAINT "Expense_amount_positive"            CHECK ("amount" > 0);
ALTER TABLE "DepositTransaction" ADD CONSTRAINT "DepositTransaction_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "BillingSchedule"    ADD CONSTRAINT "BillingSchedule_amount_positive"    CHECK ("amount" > 0);
ALTER TABLE "Lease"              ADD CONSTRAINT "Lease_monthlyRent_positive"         CHECK ("monthlyRent" > 0);
ALTER TABLE "RentableSpace"      ADD CONSTRAINT "RentableSpace_defaultRent_nonneg"   CHECK ("defaultRent" >= 0);
ALTER TABLE "Lease"              ADD CONSTRAINT "Lease_days_valid"
  CHECK ("billingDay" BETWEEN 1 AND 28 AND "dueDay" BETWEEN 1 AND 28 AND "gracePeriodDays" BETWEEN 0 AND 60);
ALTER TABLE "BillingSchedule"    ADD CONSTRAINT "BillingSchedule_days_valid"
  CHECK ("billingDay" BETWEEN 1 AND 28 AND "dueDay" BETWEEN 1 AND 28);
ALTER TABLE "Lease"              ADD CONSTRAINT "Lease_dates_ordered"
  CHECK ("endDate" IS NULL OR "endDate" >= "startDate");
ALTER TABLE "BillingSchedule"    ADD CONSTRAINT "BillingSchedule_dates_ordered"
  CHECK ("endsOn" IS NULL OR "endsOn" >= "startsOn");
ALTER TABLE "LedgerEntry"        ADD CONSTRAINT "LedgerEntry_one_sided"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" = 0) <> ("credit" = 0)));

-- ---------------------------------------------------------------------------
-- Tenancy isolation: a row may only reference parents in its own organization.
-- Application queries are already organization-scoped; this is defence in depth.
-- Usage: same_organization(column, parent_table)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rentflow_same_organization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  parent_org uuid;
BEGIN
  IF parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT "organizationId" FROM %I WHERE id = $1', TG_ARGV[1])
    INTO parent_org USING parent_id;
  IF parent_org IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'CROSS_ORGANIZATION_REFERENCE: %.% -> %', TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[1]
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER unit_property_org        BEFORE INSERT OR UPDATE ON "Unit"               FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('propertyId', 'Property');
CREATE TRIGGER space_unit_org           BEFORE INSERT OR UPDATE ON "RentableSpace"      FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('unitId', 'Unit');
CREATE TRIGGER lease_space_org          BEFORE INSERT OR UPDATE ON "Lease"              FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('rentableSpaceId', 'RentableSpace');
CREATE TRIGGER lease_tenant_org         BEFORE INSERT OR UPDATE ON "Lease"              FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('primaryTenantId', 'Tenant');
CREATE TRIGGER schedule_lease_org       BEFORE INSERT OR UPDATE ON "BillingSchedule"    FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('leaseId', 'Lease');
CREATE TRIGGER charge_lease_org         BEFORE INSERT OR UPDATE ON "Charge"             FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('leaseId', 'Lease');
CREATE TRIGGER adjustment_charge_org    BEFORE INSERT OR UPDATE ON "ChargeAdjustment"   FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('chargeId', 'Charge');
CREATE TRIGGER payment_tenant_org       BEFORE INSERT OR UPDATE ON "Payment"            FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('tenantId', 'Tenant');
CREATE TRIGGER payment_lease_org        BEFORE INSERT OR UPDATE ON "Payment"            FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('leaseId', 'Lease');
CREATE TRIGGER ledger_lease_org         BEFORE INSERT OR UPDATE ON "LedgerEntry"        FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('leaseId', 'Lease');
CREATE TRIGGER deposit_account_lease_org BEFORE INSERT OR UPDATE ON "DepositAccount"    FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('leaseId', 'Lease');
CREATE TRIGGER expense_property_org     BEFORE INSERT OR UPDATE ON "Expense"            FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('propertyId', 'Property');
CREATE TRIGGER maintenance_property_org BEFORE INSERT OR UPDATE ON "MaintenanceRequest" FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('propertyId', 'Property');
CREATE TRIGGER maintenance_unit_org     BEFORE INSERT OR UPDATE ON "MaintenanceRequest" FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('unitId', 'Unit');
