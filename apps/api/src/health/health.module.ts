import { Module } from '@nestjs/common';
import { HealthController, PrivacyController } from './health.controller.js';

@Module({ controllers: [HealthController, PrivacyController] })
export class HealthModule {}
