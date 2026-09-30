import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ExpenseCategory, MaintenancePriority, MaintenanceStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ALL_ROLES, Auth, FINANCE_READERS, MANAGERS, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { IsDateOnly, IsMoney, PageQuery } from '../common/validation.js';
import { DOCUMENT_ENTITIES, type DocumentEntity, WorkService } from './work.service.js';

const emptyToUndefined = () => Transform(({ value }) => (value === '' ? undefined : value));

class ExpenseDto {
  @emptyToUndefined() @IsOptional() @IsUUID() propertyId?: string;
  @IsEnum(ExpenseCategory) category!: ExpenseCategory;
  @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(120) vendor?: string;
  @IsMoney() amount!: string;
  @IsDateOnly() incurredOn!: string;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(100) reference?: string;
}
class ExpenseQuery extends PageQuery {
  @IsOptional() @IsUUID() propertyId?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeVoided?: boolean;
}
class MaintenanceDto {
  @IsUUID() propertyId!: string;
  @emptyToUndefined() @IsOptional() @IsUUID() unitId?: string;
  @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @IsString() @MinLength(3) @MaxLength(2000) description!: string;
  @IsEnum(MaintenancePriority) priority!: MaintenancePriority;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(120) assignedTo?: string;
  @emptyToUndefined() @IsOptional() @IsDateOnly() dueOn?: string;
}
class MaintenanceUpdateDto {
  @IsOptional() @IsEnum(MaintenanceStatus) status?: MaintenanceStatus;
  @IsOptional() @IsEnum(MaintenancePriority) priority?: MaintenancePriority;
  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsString() @MaxLength(120) assignedTo?: string | null;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(2000) description?: string;
  @IsOptional() @ValidateIf((_o, value) => value !== null) @IsDateOnly() dueOn?: string | null;
}
class MaintenanceQuery {
  @IsOptional() @IsIn(['active', 'closed', 'all']) status?: 'active' | 'closed' | 'all';
}
class DocumentDto {
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @IsString() @MinLength(2) @MaxLength(60) category!: string;
  @emptyToUndefined() @IsOptional() @IsIn(DOCUMENT_ENTITIES) entityType?: DocumentEntity;
  @emptyToUndefined() @IsOptional() @IsUUID() entityId?: string;
  @IsUrl({ require_protocol: true, protocols: ['https'], require_tld: true }) @MaxLength(2000) url!: string;
}
class DocumentQuery {
  @IsOptional() @IsIn(DOCUMENT_ENTITIES) entityType?: DocumentEntity;
  @IsOptional() @IsUUID() entityId?: string;
}
class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

const MAINTAINERS = ['OWNER', 'MANAGER', 'MAINTENANCE'] as const;

@ApiTags('operations')
@Roles(...FINANCE_READERS)
@Controller()
export class WorkController {
  constructor(private readonly work: WorkService) {}

  @Get('expenses')
  expenses(@Auth() auth: SessionContext, @Query() query: ExpenseQuery) {
    return this.work.listExpenses(auth.organizationId, query);
  }

  @Roles(...MANAGERS)
  @Post('expenses')
  createExpense(@Auth() auth: SessionContext, @Body() input: ExpenseDto) {
    return this.work.createExpense(auth.organizationId, auth.userId, input);
  }

  @Roles(...MANAGERS)
  @HttpCode(200)
  @Post('expenses/:id/void')
  voidExpense(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: ReasonDto) {
    return this.work.voidExpense(auth.organizationId, auth.userId, id, input.reason);
  }

  @Roles(...ALL_ROLES)
  @Get('maintenance')
  maintenance(@Auth() auth: SessionContext, @Query() query: MaintenanceQuery) {
    return this.work.listMaintenance(auth.organizationId, query.status);
  }

  @Roles(...MAINTAINERS)
  @Post('maintenance')
  createMaintenance(@Auth() auth: SessionContext, @Body() input: MaintenanceDto) {
    return this.work.createMaintenance(auth.organizationId, auth.userId, input);
  }

  @Roles(...MAINTAINERS)
  @Patch('maintenance/:id')
  updateMaintenance(
    @Auth() auth: SessionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: MaintenanceUpdateDto,
  ) {
    return this.work.updateMaintenance(auth.organizationId, auth.userId, id, input);
  }

  @Get('documents')
  documents(@Auth() auth: SessionContext, @Query() query: DocumentQuery) {
    return this.work.listDocuments(auth.organizationId, query);
  }

  @Roles(...MANAGERS)
  @Post('documents')
  createDocument(@Auth() auth: SessionContext, @Body() input: DocumentDto) {
    return this.work.createDocument(auth.organizationId, auth.userId, input);
  }

  @Roles(...MANAGERS)
  @Delete('documents/:id')
  deleteDocument(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.deleteDocument(auth.organizationId, auth.userId, id);
  }
}
