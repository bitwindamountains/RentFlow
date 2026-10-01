import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({ imports: [BillingModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
