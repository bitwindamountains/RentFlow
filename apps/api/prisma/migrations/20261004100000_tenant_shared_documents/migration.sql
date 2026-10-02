-- Documents a landlord shares with a tenant in the portal.
ALTER TABLE "DocumentRecord" ADD COLUMN "sharedWithTenant" BOOLEAN NOT NULL DEFAULT false;

-- Only a document attached to a tenant or a lease can be shared, so the portal's scope is unambiguous.
ALTER TABLE "DocumentRecord" ADD CONSTRAINT "DocumentRecord_sharing_scope"
  CHECK (NOT "sharedWithTenant" OR ("entityType" IN ('Tenant', 'Lease') AND "entityId" IS NOT NULL));

CREATE INDEX "DocumentRecord_shared_entity_idx" ON "DocumentRecord"("entityType", "entityId") WHERE "sharedWithTenant" AND "deletedAt" IS NULL;
