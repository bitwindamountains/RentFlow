import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RentalsModule } from '../rentals/rentals.module.js';
import { JobsService } from './jobs.service.js';

@Module({ imports: [BillingModule, RentalsModule, NotificationsModule], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
