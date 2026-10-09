CREATE TYPE "StorageObjectState" AS ENUM ('PENDING', 'READY', 'DELETE_PENDING', 'DELETED');
CREATE TABLE "StorageObject" (
  "key" TEXT PRIMARY KEY,
  "organizationId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" > 0),
  "state" "StorageObjectState" NOT NULL DEFAULT 'PENDING',
  "availableAt" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "StorageObject_organizationId_state_idx" ON "StorageObject"("organizationId", "state");
CREATE INDEX "StorageObject_state_availableAt_idx" ON "StorageObject"("state", "availableAt");
INSERT INTO "StorageObject" ("key", "organizationId", "sizeBytes", "state", "availableAt", "createdAt")
SELECT "storageKey", "organizationId", "sizeBytes",
  CASE WHEN "deletedAt" IS NULL THEN 'READY'::"StorageObjectState" ELSE 'DELETE_PENDING'::"StorageObjectState" END,
  CURRENT_TIMESTAMP, "createdAt"
FROM "DocumentRecord" WHERE "storageKey" IS NOT NULL;
