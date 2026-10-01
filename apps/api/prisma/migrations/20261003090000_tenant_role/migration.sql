-- Own migration: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "MembershipRole" ADD VALUE 'TENANT';
