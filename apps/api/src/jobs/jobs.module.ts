import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { RentalsModule } from '../rentals/rentals.module.js';
import { JobsService } from './jobs.service.js';

@Module({ imports: [BillingModule, RentalsModule], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
