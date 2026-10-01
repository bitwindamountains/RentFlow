import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DepositTransactionType, PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Auth, COLLECTORS, FINANCE_READERS, MANAGERS, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { requireIdempotencyKey } from '../common/idempotency.service.js';
import { IsMoney, PageQuery } from '../common/validation.js';
import { PaymentsService } from './payments.service.js';

const emptyToUndefined = () => Transform(({ value }) => (value === '' ? undefined : value));

class AllocationDto {
  @IsUUID() chargeId!: string;
  @IsMoney() amount!: string;
}
class PaymentDto {
  @IsUUID() tenantId!: string;
  @IsUUID() leaseId!: string;
  @IsMoney() amount!: string;
  @IsEnum(PaymentMethod) method!: PaymentMethod;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(100) referenceNumber?: string;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsISO8601({ strict: true }) paidAt!: string;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AllocationDto)
  allocations!: AllocationDto[];
}
class PaymentQuery extends PageQuery {
  @IsOptional() @IsIn(['POSTED', 'REVERSED']) status?: 'POSTED' | 'REVERSED';
  @IsOptional() @IsUUID() tenantId?: string;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class DepositDto {
  @IsEnum(DepositTransactionType) type!: DepositTransactionType;
  @IsMoney() amount!: string;
  @emptyToUndefined() @IsOptional() @IsMoney() requiredAmount?: string;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @emptyToUndefined() @IsOptional() @IsISO8601({ strict: true }) occurredAt?: string;
}

@ApiTags('payments')
@Roles(...FINANCE_READERS)
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments')
  list(@Auth() auth: SessionContext, @Query() query: PaymentQuery) {
    return this.payments.list(auth.organizationId, query);
  }

  @Roles(...COLLECTORS)
  @Get('collections/options')
  options(@Auth() auth: SessionContext) {
    return this.payments.collectionOptions(auth.organizationId);
  }

  @Roles(...COLLECTORS)
  @Post('payments')
  create(@Auth() auth: SessionContext, @Headers('idempotency-key') key: string | undefined, @Body() input: PaymentDto) {
    return this.payments.create(auth.organizationId, auth.userId, input, requireIdempotencyKey(key));
  }

  @Get('payments/:id/receipt')
  receipt(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.receipt(auth.organizationId, id);
  }

  @Roles(...MANAGERS)
  @Post('payments/:id/reverse')
  reverse(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: ReasonDto) {
    return this.payments.reverse(auth.organizationId, auth.userId, id, input.reason);
  }

  @Get('deposits')
  deposits(@Auth() auth: SessionContext) {
    return this.payments.listDeposits(auth.organizationId);
  }

  @Roles(...COLLECTORS)
  @Post('leases/:id/deposits')
  recordDeposit(
    @Auth() auth: SessionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: DepositDto,
  ) {
    return this.payments.recordDeposit(auth.organizationId, auth.userId, id, input, requireIdempotencyKey(key));
  }
}
