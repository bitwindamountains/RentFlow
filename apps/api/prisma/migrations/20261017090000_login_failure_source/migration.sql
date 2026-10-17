-- Sign-in backoff is counted per source (email + IP), so a stranger cannot lock an owner out.
-- Existing rows have no source; they only ever held 15 minutes of failures.
DELETE FROM "LoginFailure";

ALTER TABLE "LoginFailure" ADD COLUMN "ipHash" CHAR(64) NOT NULL;

CREATE INDEX "LoginFailure_emailHash_ipHash_createdAt_idx" ON "LoginFailure"("emailHash", "ipHash", "createdAt");
