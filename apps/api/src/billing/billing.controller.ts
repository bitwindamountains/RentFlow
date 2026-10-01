import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdjustmentType, ChargeType } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Auth, FINANCE_READERS, MANAGERS, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { requireIdempotencyKey } from '../common/idempotency.service.js';
import { IsDateOnly, IsMoney, PageQuery } from '../common/validation.js';
import { BillingService } from './billing.service.js';

class ScheduleDto {
  @IsUUID() leaseId!: string;
  @IsEnum(ChargeType) type!: ChargeType;
  @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @IsMoney() amount!: string;
  @IsInt() @Min(1) @Max(28) billingDay!: number;
  @IsInt() @Min(1) @Max(28) dueDay!: number;
  @IsDateOnly() startsOn!: string;
  @IsOptional() @IsDateOnly() endsOn?: string;
}
class BillingRunDto {
  @IsOptional() @IsDateOnly() asOf?: string;
}
class ChargeDto {
  @IsUUID() leaseId!: string;
  @IsEnum(ChargeType) type!: ChargeType;
  @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @IsMoney() amount!: string;
  @IsDateOnly() dueDate!: string;
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) billingPeriod?: string;
}
class ChargeQuery extends PageQuery {
  @IsOptional() @IsIn(['open', 'overdue', 'all']) status?: 'open' | 'overdue' | 'all';
  @IsOptional() @IsUUID() leaseId?: string;
}
class AdjustmentDto {
  @IsIn([AdjustmentType.DISCOUNT, AdjustmentType.WAIVER, AdjustmentType.CREDIT_NOTE])
  type!: 'DISCOUNT' | 'WAIVER' | 'CREDIT_NOTE';
  @IsMoney() amount!: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

@ApiTags('billing')
@Roles(...FINANCE_READERS)
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('billing-schedules')
  schedules(@Auth() auth: SessionContext) {
    return this.billing.listSchedules(auth.organizationId);
  }

  @Roles(...MANAGERS)
  @Post('billing-schedules')
  createSchedule(@Auth() auth: SessionContext, @Body() input: ScheduleDto) {
    return this.billing.createSchedule(auth.organizationId, auth.userId, input);
  }

  @Roles(...MANAGERS)
  @Post('billing/run')
  run(@Auth() auth: SessionContext, @Body() input: BillingRunDto) {
    return this.billing.runBilling(auth.organizationId, auth.userId, input.asOf);
  }

  @Get('charges')
  charges(@Auth() auth: SessionContext, @Query() query: ChargeQuery) {
    return this.billing.listCharges(auth.organizationId, query);
  }

  @Get('leases/:id/open-charges')
  openCharges(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.openCharges(auth.organizationId, id);
  }

  @Roles(...MANAGERS)
  @Post('charges')
  createCharge(
    @Auth() auth: SessionContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: ChargeDto,
  ) {
    return this.billing.createCharge(auth.organizationId, auth.userId, input, requireIdempotencyKey(key));
  }

  @Roles(...MANAGERS)
  @Post('charges/:id/adjustments')
  adjust(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: AdjustmentDto) {
    return this.billing.adjustCharge(auth.organizationId, auth.userId, id, input);
  }

  @Roles(...MANAGERS)
  @Post('charges/:id/void')
  void(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: ReasonDto) {
    return this.billing.voidCharge(auth.organizationId, auth.userId, id, input.reason);
  }
}
