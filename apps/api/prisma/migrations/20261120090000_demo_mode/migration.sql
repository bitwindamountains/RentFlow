-- Demo workspaces: non-null means a demo, deleted after this time.
ALTER TABLE "Organization" ADD COLUMN "demoExpiresAt" TIMESTAMPTZ(3);

CREATE INDEX "Organization_demoExpiresAt_idx" ON "Organization" ("demoExpiresAt") WHERE "demoExpiresAt" IS NOT NULL;
