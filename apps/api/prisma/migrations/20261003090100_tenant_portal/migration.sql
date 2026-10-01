-- Tenant portal: tenant-bound memberships and invitations, tenant-reported repairs, payment notices.
CREATE TYPE "PaymentNoticeStatus" AS ENUM ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'WITHDRAWN');

ALTER TABLE "Membership" ADD COLUMN "tenantId" UUID;
ALTER TABLE "StaffInvitation" ADD COLUMN "tenantId" UUID;
ALTER TABLE "MaintenanceRequest" ADD COLUMN "tenantId" UUID;

CREATE TABLE "PaymentNotice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leaseId" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "referenceNumber" TEXT,
    "paidOn" DATE NOT NULL,
    "note" TEXT,
    "status" "PaymentNoticeStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedBy" UUID NOT NULL,
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "paymentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "PaymentNotice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Membership_tenantId_idx" ON "Membership"("tenantId");
CREATE INDEX "StaffInvitation_tenantId_status_idx" ON "StaffInvitation"("tenantId", "status");
CREATE INDEX "MaintenanceRequest_tenantId_createdAt_idx" ON "MaintenanceRequest"("tenantId", "createdAt");
CREATE UNIQUE INDEX "PaymentNotice_paymentId_key" ON "PaymentNotice"("paymentId");
CREATE INDEX "PaymentNotice_organizationId_status_createdAt_idx" ON "PaymentNotice"("organizationId", "status", "createdAt");
CREATE INDEX "PaymentNotice_tenantId_createdAt_idx" ON "PaymentNotice"("tenantId", "createdAt");
CREATE INDEX "PaymentNotice_leaseId_idx" ON "PaymentNotice"("leaseId");

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A TENANT membership or invitation always names its tenant; staff ones never do.
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenant_binding"
  CHECK (("role" = 'TENANT') = ("tenantId" IS NOT NULL));
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_tenant_binding"
  CHECK (("role" = 'TENANT') = ("tenantId" IS NOT NULL));
-- At most one live portal account per tenant record.
CREATE UNIQUE INDEX "Membership_one_portal_account_per_tenant"
  ON "Membership"("tenantId") WHERE "tenantId" IS NOT NULL AND "status" <> 'REVOKED';

ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_review_state" CHECK (
  ("status" = 'CONFIRMED') = ("paymentId" IS NOT NULL)
  AND ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL)
  AND ("status" = 'SUBMITTED' OR "status" = 'WITHDRAWN' OR "reviewedAt" IS NOT NULL)
);

CREATE TRIGGER membership_tenant_org     BEFORE INSERT OR UPDATE ON "Membership"         FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('tenantId', 'Tenant');
CREATE TRIGGER invitation_tenant_org     BEFORE INSERT OR UPDATE ON "StaffInvitation"    FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('tenantId', 'Tenant');
CREATE TRIGGER maintenance_tenant_org    BEFORE INSERT OR UPDATE ON "MaintenanceRequest" FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('tenantId', 'Tenant');
CREATE TRIGGER notice_tenant_org         BEFORE INSERT OR UPDATE ON "PaymentNotice"      FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('tenantId', 'Tenant');
CREATE TRIGGER notice_lease_org          BEFORE INSERT OR UPDATE ON "PaymentNotice"      FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('leaseId', 'Lease');
CREATE TRIGGER notice_payment_org        BEFORE INSERT OR UPDATE ON "PaymentNotice"      FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('paymentId', 'Payment');
