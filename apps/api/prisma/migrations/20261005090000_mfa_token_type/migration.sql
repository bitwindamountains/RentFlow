-- A new enum value must be committed before any migration uses it.
ALTER TYPE "UserTokenType" ADD VALUE 'MFA_CHALLENGE';
