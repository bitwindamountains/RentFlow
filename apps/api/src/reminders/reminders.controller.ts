import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Auth, MANAGERS, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { RemindersService } from './reminders.service.js';

class ReminderRulesDto {
  @IsOptional() @IsBoolean() tenantReminders?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(14) daysBeforeDue?: number;
  @IsOptional() @IsBoolean() onDueDate?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsInt({ each: true }) @Min(1, { each: true }) @Max(60, { each: true }) overdueDays?: number[];
  @IsOptional() @IsBoolean() staffLeaseAlerts?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsInt({ each: true }) @Min(1, { each: true }) @Max(120, { each: true }) leaseExpiryDays?: number[];
}

/** Automatic reminder rules and the log of what was sent. Owners and managers only. */
@ApiTags('reminders')
@Roles(...MANAGERS)
@Controller()
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get('settings/reminders')
  rules(@Auth() auth: SessionContext) {
    return this.reminders.rules(auth.organizationId);
  }

  @Patch('settings/reminders')
  update(@Auth() auth: SessionContext, @Body() body: ReminderRulesDto) {
    return this.reminders.updateRules(auth.organizationId, auth.userId, body);
  }

  @Get('reminders/sent')
  sent(@Auth() auth: SessionContext) {
    return this.reminders.deliveries(auth.organizationId);
  }
}
