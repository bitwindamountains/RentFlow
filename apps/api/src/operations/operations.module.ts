import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';
import { BillingJobService } from './billing-job.service.js';

@Module({
  controllers: [OperationsController],
  providers: [OperationsService, BillingJobService],
})
export class OperationsModule {}
