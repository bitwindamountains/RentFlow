-- Existing workspaces start with the requirement off, so no owner is locked out by
-- the deploy; new workspaces default to on.
ALTER TABLE "Organization" ADD COLUMN "requireOwnerMfa" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ALTER COLUMN "requireOwnerMfa" SET DEFAULT true;
