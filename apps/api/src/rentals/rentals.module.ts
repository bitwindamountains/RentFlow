import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { LeasesService } from './leases.service.js';
import { PropertiesService } from './properties.service.js';
import { RentalsController } from './rentals.controller.js';
import { RentalSetupService } from './setup.service.js';
import { TenantsService } from './tenants.service.js';

@Module({
  imports: [BillingModule],
  controllers: [RentalsController],
  providers: [PropertiesService, TenantsService, LeasesService, RentalSetupService],
  exports: [LeasesService],
})
export class RentalsModule {}
