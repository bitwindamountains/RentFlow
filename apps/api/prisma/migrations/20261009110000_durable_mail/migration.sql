CREATE TABLE "MailDelivery" (
  "id" UUID PRIMARY KEY,
  "organizationId" UUID,
  "userId" UUID,
  "kind" TEXT NOT NULL,
  "encryptedBody" TEXT,
  "tokenId" UUID,
  "invitationId" UUID,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "processedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MailDelivery_status_availableAt_idx" ON "MailDelivery"("status", "availableAt");
CREATE INDEX "MailDelivery_organizationId_status_idx" ON "MailDelivery"("organizationId", "status");
CREATE INDEX "MailDelivery_expiresAt_idx" ON "MailDelivery"("expiresAt");
