import { Module } from '@nestjs/common';
import { RemindersController } from './reminders.controller.js';
import { RemindersService } from './reminders.service.js';

@Module({ controllers: [RemindersController], providers: [RemindersService], exports: [RemindersService] })
export class RemindersModule {}
