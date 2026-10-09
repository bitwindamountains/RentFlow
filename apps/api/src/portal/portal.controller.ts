import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MaintenancePriority, PaymentMethod } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Auth, COLLECTORS, FINANCE_READERS, MANAGERS, RateLimit, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { DomainError } from '../common/errors.js';
import { requireIdempotencyKey } from '../common/idempotency.service.js';
import { IsDateOnly, IsMoney, PageQuery } from '../common/validation.js';
import { arrayPage } from '../common/pagination.js';
import { isUploadType } from '../storage/file-store.service.js';
import { sendDocument } from '../work/document-response.js';
import { PortalAdminService } from './portal-admin.service.js';
import { PortalService } from './portal.service.js';

const emptyToUndefined = () => Transform(({ value }) => (value === '' ? undefined : value));
/** Ways a tenant can pay without staff present; cash is still allowed (e.g. left with a caretaker). */
const NOTICE_METHODS: PaymentMethod[] = ['GCASH', 'MAYA', 'BANK_TRANSFER', 'CASH', 'CHEQUE', 'OTHER'];

class MaintenanceReportDto {
  @emptyToUndefined() @IsOptional() @IsUUID() leaseId?: string;
  @IsString() @MinLength(3) @MaxLength(160) title!: string;
  @IsString() @MinLength(5) @MaxLength(2000) description!: string;
  @IsEnum(MaintenancePriority) priority!: MaintenancePriority;
}
class NoticeDto {
  @IsUUID() leaseId!: string;
  @IsMoney() amount!: string;
  @IsIn(NOTICE_METHODS) method!: PaymentMethod;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(100) referenceNumber?: string;
  @IsDateOnly() paidOn!: string;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class InviteDto {
  @emptyToUndefined() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
}
class NoticeQuery extends PageQuery {
  @IsOptional() @IsIn(['SUBMITTED', 'all']) status?: 'SUBMITTED' | 'all';
}
class HistoryQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(200) paymentsCursor?: string;
  @IsOptional() @IsString() @MaxLength(200) noticesCursor?: string;
}
class ConfirmDto {
  @IsOptional() @IsMoney() amount?: string;
  @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
  @emptyToUndefined() @IsOptional() @IsString() @MaxLength(100) referenceNumber?: string;
  @IsOptional() @IsDateOnly() paidOn?: string;
}
class RejectDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

/** The tenant's own view. Only TENANT sessions reach these routes. */
@ApiTags('tenant portal')
@Roles('TENANT')
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('home')
  home(@Auth() auth: SessionContext) {
    return this.portal.home(auth);
  }

  @Get('payments')
  payments(@Auth() auth: SessionContext, @Query() query: HistoryQuery) {
    return this.portal.paymentHistory(auth, query);
  }

  @Get('payments/:id/receipt')
  receipt(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.receipt(auth, id);
  }

  @Get('maintenance')
  async maintenance(@Auth() auth: SessionContext, @Query() query: PageQuery, @Res({ passthrough: true }) reply: FastifyReply) {
    return arrayPage(reply, await this.portal.maintenance(auth, query));
  }

  @Get('documents')
  async documents(@Auth() auth: SessionContext, @Query() query: PageQuery, @Res({ passthrough: true }) reply: FastifyReply) {
    return arrayPage(reply, await this.portal.documents(auth, query));
  }

  @Get('documents/:id/file')
  async downloadDocument(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    return sendDocument(reply, await this.portal.openDocument(auth, id));
  }

  @RateLimit(20, '1 hour')
  @Post('maintenance')
  reportMaintenance(@Auth() auth: SessionContext, @Body() input: MaintenanceReportDto) {
    return this.portal.reportMaintenance(auth, input);
  }

  @RateLimit(20, '1 hour')
  @Post('payment-notices')
  submitNotice(
    @Auth() auth: SessionContext,
    @Body() input: NoticeDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.portal.submitNotice(auth, input, requireIdempotencyKey(key));
  }

  @HttpCode(200)
  @Post('payment-notices/:id/withdraw')
  withdrawNotice(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.withdrawNotice(auth, id);
  }

  /** Raw image or PDF body, like document uploads. */
  @RateLimit(20, '1 hour')
  @Post('payment-notices/:id/proof')
  attachProof(
    @Auth() auth: SessionContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const type = String(contentType ?? '').split(';')[0]!.trim().toLowerCase();
    if (!isUploadType(type) || !Buffer.isBuffer(request.body)) throw new DomainError('FILE_TYPE_MISMATCH', 415);
    return this.portal.attachProof(auth, id, type, request.body);
  }
}

/** Staff tools for the portal: access per tenant and the payment-notice review queue. */
@ApiTags('tenant portal (staff)')
@Controller()
export class PortalAdminController {
  constructor(private readonly admin: PortalAdminService) {}

  @Roles(...MANAGERS)
  @Get('tenants/:id/portal')
  access(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.access(auth.organizationId, id);
  }

  @Roles(...MANAGERS)
  @RateLimit(30, '1 hour')
  @Post('tenants/:id/portal/invite')
  invite(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: InviteDto) {
    return this.admin.invite(auth.organizationId, auth.userId, id, input.email);
  }

  @Roles(...MANAGERS)
  @Delete('tenants/:id/portal')
  revoke(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.revoke(auth.organizationId, auth.userId, id);
  }

  @Roles(...FINANCE_READERS)
  @Get('payment-notices')
  async notices(@Auth() auth: SessionContext, @Query() query: NoticeQuery, @Res({ passthrough: true }) reply: FastifyReply) {
    return arrayPage(reply, await this.admin.listNotices(auth.organizationId, query));
  }

  @Roles(...COLLECTORS)
  @HttpCode(200)
  @Post('payment-notices/:id/confirm')
  confirm(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: ConfirmDto) {
    return this.admin.confirmNotice(auth.organizationId, auth.userId, id, input);
  }

  @Roles(...COLLECTORS)
  @HttpCode(200)
  @Post('payment-notices/:id/reject')
  reject(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: RejectDto) {
    return this.admin.rejectNotice(auth.organizationId, auth.userId, id, input.reason);
  }
}
