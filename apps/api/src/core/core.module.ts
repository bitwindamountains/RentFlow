import { Module } from '@nestjs/common';
import { FlowController } from './flow.controller.js';
import { RentalSetupService } from './rental-setup.service.js';

@Module({ controllers: [FlowController], providers: [RentalSetupService] })
export class CoreModule {}
