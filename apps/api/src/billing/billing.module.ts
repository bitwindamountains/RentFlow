import { Module } from '@nestjs/common';
import { BalancesService } from './balances.service.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

@Module({
  controllers: [BillingController],
  providers: [BillingService, BalancesService],
  exports: [BillingService, BalancesService],
})
export class BillingModule {}
