import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ChargeType,
  DepositTransactionType,
  ExpenseCategory,
  MaintenancePriority,
  MaintenanceStatus,
  MembershipRole,
} from '@prisma/client';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { OperationsService } from './operations.service.js';

class BillingScheduleDto {
  @IsString() leaseId!: string;
  @IsEnum(ChargeType) type!: ChargeType;
  @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @IsString() amount!: string;
  @IsInt() @Min(1) @Max(28) billingDay!: number;
  @IsInt() @Min(1) @Max(28) dueDay!: number;
  @IsDateString() startsOn!: string;
  @IsOptional() @IsDateString() endsOn?: string;
}
class BillingRunDto {
  @IsOptional() @IsDateString() asOf?: string;
}
class TerminateLeaseDto {
  @IsDateString() endDate!: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class RenewLeaseDto {
  @IsDateString() endDate!: string;
  @IsOptional() @IsString() monthlyRent?: string;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class DepositDto {
  @IsEnum(DepositTransactionType) type!: DepositTransactionType;
  @IsString() amount!: string;
  @IsOptional() @IsString() requiredAmount?: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsDateString() occurredAt?: string;
}
class ExpenseDto {
  @IsOptional() @IsString() propertyId?: string;
  @IsEnum(ExpenseCategory) category!: ExpenseCategory;
  @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @IsOptional() @IsString() @MaxLength(120) vendor?: string;
  @IsString() amount!: string;
  @IsDateString() incurredOn!: string;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}
class MaintenanceDto {
  @IsString() propertyId!: string;
  @IsOptional() @IsString() unitId?: string;
  @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @IsString() @MinLength(3) @MaxLength(2000) description!: string;
  @IsEnum(MaintenancePriority) priority!: MaintenancePriority;
  @IsOptional() @IsString() @MaxLength(120) assignedTo?: string;
  @IsOptional() @IsDateString() dueOn?: string;
}
class MaintenanceUpdateDto {
  @IsOptional() @IsEnum(MaintenanceStatus) status?: MaintenanceStatus;
  @IsOptional() @IsEnum(MaintenancePriority) priority?: MaintenancePriority;
  @IsOptional() @IsString() @MaxLength(120) assignedTo?: string;
}
class DocumentDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsString() @MinLength(2) @MaxLength(60) category!: string;
  @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @IsOptional() @IsString() @MaxLength(100) entityId?: string;
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2000)
  url!: string;
}
class InvitationDto {
  @IsEmail() email!: string;
  @IsEnum(MembershipRole) role!: MembershipRole;
}
class AcceptInvitationDto {
  @IsString() @MinLength(20) @MaxLength(100) token!: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

@ApiTags('operations')
@Roles('OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER')
@Controller()
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('billing-schedules') schedules(@Req() req: AuthenticatedRequest) {
    return this.operations.listBillingSchedules(req.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER') @Post('billing-schedules') createSchedule(
    @Req() req: AuthenticatedRequest,
    @Body() input: BillingScheduleDto,
  ) {
    return this.operations.createBillingSchedule(
      req.auth.organizationId,
      req.auth.userId,
      input,
    );
  }
  @Roles('OWNER', 'MANAGER') @Post('billing/run') runBilling(
    @Req() req: AuthenticatedRequest,
    @Body() input: BillingRunDto,
  ) {
    return this.operations.runBilling(
      req.auth.organizationId,
      req.auth.userId,
      input.asOf,
    );
  }
  @Roles('OWNER', 'MANAGER') @Post('leases/:id/terminate') terminateLease(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: TerminateLeaseDto,
  ) {
    return this.operations.terminateLease(
      req.auth.organizationId,
      req.auth.userId,
      id,
      input,
    );
  }
  @Roles('OWNER', 'MANAGER') @Post('leases/:id/renew') renewLease(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: RenewLeaseDto,
  ) {
    return this.operations.renewLease(
      req.auth.organizationId,
      req.auth.userId,
      id,
      input,
    );
  }
  @Roles('OWNER', 'MANAGER') @Post('payments/:id/reverse') reversePayment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: ReasonDto,
  ) {
    return this.operations.reversePayment(
      req.auth.organizationId,
      req.auth.userId,
      id,
      input.reason,
    );
  }

  @Get('deposits') deposits(@Req() req: AuthenticatedRequest) {
    return this.operations.listDeposits(req.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER', 'COLLECTOR')
  @Post('leases/:id/deposits')
  recordDeposit(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: DepositDto,
    @Headers('idempotency-key') key: string,
  ) {
    if (!key || key.length < 8 || key.length > 100)
      throw new Error('INVALID_IDEMPOTENCY_KEY');
    return this.operations.recordDeposit(
      req.auth.organizationId,
      req.auth.userId,
      id,
      input,
      key,
    );
  }
  @Get('expenses') expenses(@Req() req: AuthenticatedRequest) {
    return this.operations.listExpenses(req.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER') @Post('expenses') createExpense(
    @Req() req: AuthenticatedRequest,
    @Body() input: ExpenseDto,
  ) {
    return this.operations.createExpense(
      req.auth.organizationId,
      req.auth.userId,
      input,
    );
  }
  @Roles('OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER', 'MAINTENANCE')
  @Get('maintenance')
  maintenance(@Req() req: AuthenticatedRequest) {
    return this.operations.listMaintenance(req.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER', 'MAINTENANCE')
  @Post('maintenance')
  createMaintenance(
    @Req() req: AuthenticatedRequest,
    @Body() input: MaintenanceDto,
  ) {
    return this.operations.createMaintenance(
      req.auth.organizationId,
      req.auth.userId,
      input,
    );
  }
  @Roles('OWNER', 'MANAGER', 'MAINTENANCE')
  @Patch('maintenance/:id')
  updateMaintenance(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: MaintenanceUpdateDto,
  ) {
    return this.operations.updateMaintenance(
      req.auth.organizationId,
      req.auth.userId,
      id,
      input,
    );
  }
  @Get('documents') documents(@Req() req: AuthenticatedRequest) {
    return this.operations.listDocuments(req.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER') @Post('documents') createDocument(
    @Req() req: AuthenticatedRequest,
    @Body() input: DocumentDto,
  ) {
    return this.operations.createDocument(
      req.auth.organizationId,
      req.auth.userId,
      input,
    );
  }
  @Roles('OWNER', 'MANAGER')
  @Delete('documents/:id')
  @HttpCode(200)
  deleteDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.operations.deleteDocument(
      req.auth.organizationId,
      req.auth.userId,
      id,
    );
  }
  @Get('reminders') reminders(@Req() req: AuthenticatedRequest) {
    return this.operations.reminders(req.auth.organizationId);
  }

  @Roles('OWNER') @Get('staff') staff(@Req() req: AuthenticatedRequest) {
    return this.operations.listStaff(req.auth.organizationId);
  }
  @Roles('OWNER') @Post('staff/invitations') invite(
    @Req() req: AuthenticatedRequest,
    @Body() input: InvitationDto,
  ) {
    return this.operations.inviteStaff(
      req.auth.organizationId,
      req.auth.userId,
      input,
    );
  }
  @Public() @Post('staff/invitations/accept') accept(
    @Body() input: AcceptInvitationDto,
  ) {
    return this.operations.acceptInvitation(input);
  }

  @Get('reports/financial') report(@Req() req: AuthenticatedRequest) {
    return this.operations.financialReport(req.auth.organizationId);
  }
  @Get('reports/transactions.csv') async csv(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const csv = await this.operations.transactionsCsv(req.auth.organizationId);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="rentflow-transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return csv;
  }
}
