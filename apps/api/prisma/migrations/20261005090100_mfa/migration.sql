-- Two-step sign-in with an authenticator app, plus one-time recovery codes.
ALTER TABLE "User" ADD COLUMN "mfaSecret" TEXT,
ADD COLUMN "mfaPendingSecret" TEXT,
ADD COLUMN "mfaEnabledAt" TIMESTAMPTZ(3),
ADD COLUMN "mfaLastStep" INTEGER;

ALTER TABLE "UserToken" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "MfaRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MfaRecoveryCode_codeHash_key" ON "MfaRecoveryCode"("codeHash");
CREATE INDEX "MfaRecoveryCode_userId_idx" ON "MfaRecoveryCode"("userId");

ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MFA is on exactly when an active secret is stored.
ALTER TABLE "User" ADD CONSTRAINT "User_mfa_state" CHECK (("mfaEnabledAt" IS NULL) = ("mfaSecret" IS NULL));
