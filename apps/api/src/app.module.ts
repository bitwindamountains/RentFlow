import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { SessionGuard } from './auth/session.guard.js';
import { BillingModule } from './billing/billing.module.js';
import { CommonModule } from './common/common.module.js';
import { ErrorFilter } from './common/error.filter.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { RentalsModule } from './rentals/rentals.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { StaffModule } from './staff/staff.module.js';
import { WorkModule } from './work/work.module.js';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    RentalsModule,
    BillingModule,
    PaymentsModule,
    ReportsModule,
    StaffModule,
    WorkModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
