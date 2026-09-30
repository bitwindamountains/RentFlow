import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { Auth, FINANCE_READERS, MANAGERS, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { IsDateOnly } from '../common/validation.js';
import { ReportsService } from './reports.service.js';

class RangeQuery {
  @IsOptional() @IsDateOnly() from?: string;
  @IsOptional() @IsDateOnly() to?: string;
}
class AuditQuery {
  @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@ApiTags('reports')
@Roles(...FINANCE_READERS)
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@Auth() auth: SessionContext) {
    return this.reports.dashboard(auth.organizationId);
  }

  @Get('arrears')
  arrears(@Auth() auth: SessionContext) {
    return this.reports.arrears(auth.organizationId);
  }

  @Get('reminders')
  reminders(@Auth() auth: SessionContext) {
    return this.reports.reminders(auth.organizationId);
  }

  @Get('reports/financial')
  financial(@Auth() auth: SessionContext, @Query() query: RangeQuery) {
    return this.reports.financial(auth.organizationId, query);
  }

  @Get('reports/transactions.csv')
  async csv(@Auth() auth: SessionContext, @Query() query: RangeQuery, @Res({ passthrough: true }) reply: FastifyReply) {
    const { csv, range } = await this.reports.transactionsCsv(auth.organizationId, query);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('cache-control', 'no-store');
    reply.header('content-disposition', `attachment; filename="rentflow-transactions-${range.from}-to-${range.to}.csv"`);
    return csv;
  }

  @Roles(...MANAGERS)
  @Get('audit-log')
  auditLog(@Auth() auth: SessionContext, @Query() query: AuditQuery) {
    return this.reports.auditLog(auth.organizationId, query);
  }
}
