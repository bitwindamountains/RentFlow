CREATE INDEX "Payment_organizationId_tenantId_paidAt_id_idx" ON "Payment"("organizationId", "tenantId", "paidAt", "id");
CREATE INDEX "MaintenanceRequest_staff_page_idx" ON "MaintenanceRequest"("organizationId", "status", "priority" DESC, "createdAt" DESC, "id" DESC);
CREATE INDEX "MaintenanceRequest_portal_page_idx" ON "MaintenanceRequest"("organizationId", "tenantId", "createdAt", "id");
CREATE INDEX "DocumentRecord_organizationId_createdAt_id_idx" ON "DocumentRecord"("organizationId", "createdAt", "id");
CREATE INDEX "PaymentNotice_staff_page_idx" ON "PaymentNotice"("organizationId", "status", "createdAt", "id");
CREATE INDEX "PaymentNotice_portal_page_idx" ON "PaymentNotice"("organizationId", "tenantId", "createdAt", "id");
