-- Retain command identities indefinitely, including keys issued by older releases.
ALTER TABLE "IdempotencyKey" ALTER COLUMN "expiresAt" DROP NOT NULL;
UPDATE "IdempotencyKey" SET "expiresAt" = NULL;

-- Persist successful alert recipients so a partial failure retries only those remaining.
ALTER TABLE "OutboxEvent" ADD COLUMN "deliveredTo" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
