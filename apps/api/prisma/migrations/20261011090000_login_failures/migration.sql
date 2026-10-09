-- Per-account sign-in backoff (not organization-owned, so no same-organization trigger).
CREATE TABLE "LoginFailure" (
    "id" UUID NOT NULL,
    "emailHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginFailure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginFailure_emailHash_createdAt_idx" ON "LoginFailure"("emailHash", "createdAt");
CREATE INDEX "LoginFailure_createdAt_idx" ON "LoginFailure"("createdAt");
