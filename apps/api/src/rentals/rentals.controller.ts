import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEmail,
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
  ValidateNested,
} from 'class-validator';
import { ALL_ROLES, Auth, FINANCE_READERS, MANAGERS, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { requireIdempotencyKey } from '../common/idempotency.service.js';
import { IsDateOnly, IsMoney } from '../common/validation.js';
import { LeasesService, type FirstMonthMode } from './leases.service.js';
import { PropertiesService } from './properties.service.js';
import { RentalSetupService } from './setup.service.js';
import { TenantPrivacyService } from './tenant-privacy.service.js';
import { TenantsService } from './tenants.service.js';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
class EraseTenantDto {
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

const emptyToUndefined = () => Transform(({ value }) => (value === '' ? undefined : value));
const FIRST_MONTH: FirstMonthMode[] = ['FULL', 'PRORATED', 'NONE'];

class PropertyDto {
  @trim() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @trim() @IsString() @MinLength(2) @MaxLength(60) type!: string;
  @trim() @IsString() @MinLength(5) @MaxLength(200) address!: string;
  @trim() @IsString() @MinLength(2) @MaxLength(80) city!: string;
}
class UnitDto {
  @trim() @IsString() @MinLength(1) @MaxLength(30) number!: string;
  @trim() @IsString() @MinLength(2) @MaxLength(60) type!: string;
  @IsMoney() monthlyRent!: string;
}
class TenantDto {
  @trim() @IsString() @MinLength(1) @MaxLength(80) firstName!: string;
  @trim() @IsString() @MinLength(1) @MaxLength(80) lastName!: string;
  @emptyToUndefined() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @emptyToUndefined() @IsOptional() @Matches(/^[+0-9 ()-]{7,20}$/, { message: 'phone must be a valid phone number' }) phone?: string;
}
class LeaseTermsDto {
  @IsDateOnly() startDate!: string;
  @emptyToUndefined() @IsOptional() @IsDateOnly() endDate?: string;
  @IsMoney() monthlyRent!: string;
  @IsInt() @Min(1) @Max(28) billingDay!: number;
  @IsInt() @Min(1) @Max(28) dueDay!: number;
  @IsOptional() @IsInt() @Min(0) @Max(60) gracePeriodDays?: number;
  @emptyToUndefined() @IsOptional() @IsMoney() depositRequired?: string;
  @IsOptional() @IsIn(FIRST_MONTH) firstMonth?: FirstMonthMode;
}
class LeaseDto extends LeaseTermsDto {
  @IsUUID() unitId!: string;
  @IsUUID() tenantId!: string;
}
class RenewDto {
  @IsDateOnly() endDate!: string;
  @emptyToUndefined() @IsOptional() @IsMoney() monthlyRent?: string;
}
class RentChangeDto {
  @IsDateOnly() effectiveFrom!: string;
  @IsMoney() monthlyRent!: string;
}
class TerminateDto {
  @IsDateOnly() endDate!: string;
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
class SetupChargeDto {
  @trim() @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @IsDateOnly() dueDate!: string;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) billingPeriod!: string;
}
class RentalSetupDto {
  @IsDefined() @ValidateNested() @Type(() => PropertyDto) property!: PropertyDto;
  @IsDefined() @ValidateNested() @Type(() => UnitDto) unit!: UnitDto;
  @IsDefined() @ValidateNested() @Type(() => TenantDto) tenant!: TenantDto;
  @IsDefined() @ValidateNested() @Type(() => LeaseTermsDto) lease!: LeaseTermsDto;
  @IsDefined() @ValidateNested() @Type(() => SetupChargeDto) charge!: SetupChargeDto;
}
class TenantQuery {
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeArchived?: boolean;
}

@ApiTags('rentals')
@Roles(...FINANCE_READERS)
@Controller()
export class RentalsController {
  constructor(
    private readonly properties: PropertiesService,
    private readonly tenants: TenantsService,
    private readonly leases: LeasesService,
    private readonly setup: RentalSetupService,
    private readonly privacy: TenantPrivacyService,
  ) {}

  @Roles(...ALL_ROLES)
  @Get('properties')
  listProperties(@Auth() auth: SessionContext) {
    return this.properties.list(auth.organizationId, auth.role);
  }

  @Roles(...MANAGERS)
  @Post('properties')
  createProperty(@Auth() auth: SessionContext, @Body() input: PropertyDto) {
    return this.properties.create(auth.organizationId, auth.userId, input);
  }

  @Roles(...MANAGERS)
  @Patch('properties/:id')
  updateProperty(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: PropertyDto) {
    return this.properties.update(auth.organizationId, auth.userId, id, input);
  }

  @Roles(...MANAGERS)
  @Post('properties/:id/units')
  createUnit(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: UnitDto) {
    return this.properties.createUnit(auth.organizationId, auth.userId, id, input);
  }

  @Roles(...MANAGERS)
  @Patch('units/:id')
  updateUnit(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: UnitDto) {
    return this.properties.updateUnit(auth.organizationId, auth.userId, id, input);
  }

  @Get('tenants')
  listTenants(@Auth() auth: SessionContext, @Query() query: TenantQuery) {
    return this.tenants.list(auth.organizationId, query.includeArchived);
  }

  @Get('tenants/:id')
  tenant(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.detail(auth.organizationId, id);
  }

  @Roles(...MANAGERS)
  @Post('tenants')
  createTenant(@Auth() auth: SessionContext, @Body() input: TenantDto) {
    return this.tenants.create(auth.organizationId, auth.userId, input);
  }

  @Roles(...MANAGERS)
  @Patch('tenants/:id')
  updateTenant(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: TenantDto) {
    return this.tenants.update(auth.organizationId, auth.userId, id, input);
  }

  @Roles(...MANAGERS)
  @Post('tenants/:id/archive')
  archiveTenant(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.archive(auth.organizationId, auth.userId, id);
  }

  /** Everything the workspace holds about one tenant, for a data-subject access request. */
  @Roles(...MANAGERS)
  @Get('tenants/:id/export')
  exportTenant(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.privacy.export(auth.organizationId, auth.userId, id);
  }

  /** Erases a former tenant's personal details; financial records stay, anonymized. */
  @Roles('OWNER')
  @Post('tenants/:id/erase')
  eraseTenant(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: EraseTenantDto) {
    return this.privacy.erase(auth.organizationId, auth.userId, id, input.password);
  }

  @Get('leases')
  listLeases(@Auth() auth: SessionContext) {
    return this.leases.list(auth.organizationId);
  }

  @Roles(...MANAGERS)
  @Post('leases')
  createLease(@Auth() auth: SessionContext, @Body() input: LeaseDto) {
    return this.leases.create(auth.organizationId, auth.userId, input);
  }

  @Roles(...MANAGERS)
  @Post('leases/:id/renew')
  renew(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: RenewDto) {
    return this.leases.renew(auth.organizationId, auth.userId, id, input);
  }

  @Roles(...MANAGERS)
  @Post('leases/:id/rent-change')
  changeRent(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: RentChangeDto) {
    return this.leases.changeRent(auth.organizationId, auth.userId, id, input);
  }

  @Roles(...MANAGERS)
  @Post('leases/:id/terminate')
  terminate(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string, @Body() input: TerminateDto) {
    return this.leases.terminate(auth.organizationId, auth.userId, id, input);
  }

  @Get('leases/:id/ledger')
  ledger(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.leases.ledger(auth.organizationId, id);
  }

  @Roles(...MANAGERS)
  @Post('rental-setup')
  createRental(
    @Auth() auth: SessionContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: RentalSetupDto,
  ) {
    return this.setup.create(auth.organizationId, auth.userId, requireIdempotencyKey(key), input);
  }
}
