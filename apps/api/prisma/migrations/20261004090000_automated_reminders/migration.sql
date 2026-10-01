-- Automated reminders: per-workspace rules and an at-most-once delivery log.
CREATE TYPE "ReminderKind" AS ENUM ('RENT_DUE_SOON', 'RENT_DUE_TODAY', 'RENT_OVERDUE', 'LEASE_EXPIRING');
CREATE TYPE "ReminderDeliveryStatus" AS ENUM ('SENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "ReminderSettings" (
    "organizationId" UUID NOT NULL,
    "tenantReminders" BOOLEAN NOT NULL DEFAULT false,
    "daysBeforeDue" INTEGER NOT NULL DEFAULT 3,
    "onDueDate" BOOLEAN NOT NULL DEFAULT true,
    "overdueDays" INTEGER[] DEFAULT ARRAY[3, 7]::INTEGER[],
    "staffLeaseAlerts" BOOLEAN NOT NULL DEFAULT true,
    "leaseExpiryDays" INTEGER[] DEFAULT ARRAY[60, 30, 7]::INTEGER[],
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ReminderSettings_pkey" PRIMARY KEY ("organizationId")
);

CREATE TABLE "ReminderDelivery" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "leaseId" UUID NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "subjectDate" DATE NOT NULL,
    "step" INTEGER NOT NULL,
    "status" "ReminderDeliveryStatus" NOT NULL DEFAULT 'SENDING',
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(19,4),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ReminderDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReminderDelivery_leaseId_kind_subjectDate_step_key" ON "ReminderDelivery"("leaseId", "kind", "subjectDate", "step");
CREATE INDEX "ReminderDelivery_organizationId_createdAt_idx" ON "ReminderDelivery"("organizationId", "createdAt");

ALTER TABLE "ReminderSettings" ADD CONSTRAINT "ReminderSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReminderDelivery" ADD CONSTRAINT "ReminderDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReminderDelivery" ADD CONSTRAINT "ReminderDelivery_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rules stay within what the screens offer, whatever writes them.
ALTER TABLE "ReminderSettings" ADD CONSTRAINT "ReminderSettings_ranges" CHECK (
  "daysBeforeDue" BETWEEN 0 AND 14
  AND cardinality("overdueDays") <= 3 AND 1 <= ALL("overdueDays") AND 60 >= ALL("overdueDays")
  AND cardinality("leaseExpiryDays") <= 3 AND 1 <= ALL("leaseExpiryDays") AND 120 >= ALL("leaseExpiryDays")
);

CREATE TRIGGER reminder_delivery_lease_org BEFORE INSERT OR UPDATE ON "ReminderDelivery" FOR EACH ROW EXECUTE FUNCTION rentflow_same_organization('leaseId', 'Lease');
