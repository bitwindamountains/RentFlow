import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { RentalsModule } from '../rentals/rentals.module.js';
import { WorkModule } from '../work/work.module.js';
import { DemoController } from './demo.controller.js';
import { DemoService } from './demo.service.js';

@Module({
  imports: [AuthModule, RentalsModule, BillingModule, PaymentsModule, WorkModule],
  controllers: [DemoController],
  providers: [DemoService],
})
export class DemoModule {}
