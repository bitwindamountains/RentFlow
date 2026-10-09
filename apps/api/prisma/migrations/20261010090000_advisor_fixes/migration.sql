-- Pin the trigger function's search_path to the schema it was created in
-- (it resolves table names dynamically; a caller's search_path must not change that).
ALTER FUNCTION rentflow_same_organization() SET search_path FROM CURRENT;

-- Covering indexes for foreign keys (parent deletes/updates and per-parent lookups).
CREATE INDEX "PropertyGrant_propertyId_idx" ON "PropertyGrant"("propertyId");
CREATE INDEX "PaymentReversal_paymentId_idx" ON "PaymentReversal"("paymentId");
CREATE INDEX "DepositAccount_organizationId_idx" ON "DepositAccount"("organizationId");
CREATE INDEX "MaintenanceRequest_unitId_idx" ON "MaintenanceRequest"("unitId");
