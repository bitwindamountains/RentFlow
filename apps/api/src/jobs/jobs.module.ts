import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { RemindersModule } from '../reminders/reminders.module.js';
import { RentalsModule } from '../rentals/rentals.module.js';
import { JobsService } from './jobs.service.js';

@Module({ imports: [BillingModule, RentalsModule, RemindersModule], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
