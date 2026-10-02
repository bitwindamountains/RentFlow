import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { WorkModule } from '../work/work.module.js';
import { PortalAdminService } from './portal-admin.service.js';
import { PortalAdminController, PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';

@Module({
  imports: [BillingModule, PaymentsModule, WorkModule, NotificationsModule],
  controllers: [PortalController, PortalAdminController],
  providers: [PortalService, PortalAdminService],
})
export class PortalModule {}
