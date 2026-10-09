-- Marks tenants whose personal details were erased (Data Privacy Act requests).
ALTER TABLE "Tenant" ADD COLUMN "erasedAt" TIMESTAMPTZ(3);
