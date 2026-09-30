import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Patch,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  IsDefined,
} from 'class-validator';
import { RentalSetupService } from './rental-setup.service.js';
import { PrismaService } from './prisma.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { DOMAIN_SERVICE, type DomainService } from './domain-service.js';

class PropertyDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsString() @MinLength(2) @MaxLength(60) type!: string;
  @IsString() @MinLength(5) @MaxLength(200) address!: string;
  @IsString() @MinLength(2) @MaxLength(80) city!: string;
}
class UnitDto {
  @IsString() @MinLength(1) @MaxLength(30) number!: string;
  @IsString() @MinLength(2) @MaxLength(60) type!: string;
  @IsString() monthlyRent!: string;
}
class TenantDto {
  @IsString() @MinLength(1) @MaxLength(80) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(80) lastName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}
class LeaseDto {
  @IsString() unitId!: string;
  @IsString() tenantId!: string;
  @IsDateString() startDate!: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsString() monthlyRent!: string;
  @IsInt() @Min(1) @Max(28) billingDay!: number;
  @IsInt() @Min(1) @Max(28) dueDay!: number;
}
class ChargeDto {
  @IsString() leaseId!: string;
  @IsString()
  @IsIn(['RENT', 'ELECTRICITY', 'WATER', 'INTERNET', 'PENALTY', 'OTHER'])
  type!: string;
  @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @IsString() amount!: string;
  @IsDateString() dueDate!: string;
  @IsOptional() @IsString() billingPeriod?: string;
}
class AllocationDto {
  @IsString() chargeId!: string;
  @IsString() amount!: string;
}
class PaymentDto {
  @IsString() tenantId!: string;
  @IsString() leaseId!: string;
  @IsString() amount!: string;
  @IsString()
  @IsIn(['CASH', 'GCASH', 'MAYA', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER'])
  method!: string;
  @IsOptional() @IsString() @MaxLength(100) referenceNumber?: string;
  @IsDateString() paidAt!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations!: AllocationDto[];
}

class SetupLeaseDto {
  @IsDateString() startDate!: string;
  @IsString() monthlyRent!: string;
  @IsInt() @Min(1) @Max(28) billingDay!: number;
  @IsInt() @Min(1) @Max(28) dueDay!: number;
}
class SetupChargeDto {
  @IsString() @MinLength(2) @MaxLength(180) description!: string;
  @IsDateString() dueDate!: string;
  @IsString() billingPeriod!: string;
}
export class RentalSetupDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => PropertyDto)
  property!: PropertyDto;
  @IsDefined() @ValidateNested() @Type(() => UnitDto) unit!: UnitDto;
  @IsDefined() @ValidateNested() @Type(() => TenantDto) tenant!: TenantDto;
  @IsDefined()
  @ValidateNested()
  @Type(() => SetupLeaseDto)
  lease!: SetupLeaseDto;
  @IsDefined()
  @ValidateNested()
  @Type(() => SetupChargeDto)
  charge!: SetupChargeDto;
}

@ApiTags('rental operations')
@Roles('OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER')
@Controller()
export class FlowController {
  constructor(
    @Inject(DOMAIN_SERVICE) private readonly store: DomainService,
    private readonly setup: RentalSetupService,
    private readonly prisma: PrismaService,
  ) {}
  @Roles('OWNER', 'MANAGER')
  @Patch('properties/:id')
  updateProperty(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: PropertyDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.property.findFirst({
        where: { id, organizationId: request.auth.organizationId },
      });
      if (!before) throw new Error('PROPERTY_NOT_FOUND');
      await tx.property.update({
        where: { id },
        data: {
          name: input.name.trim(),
          type: input.type,
          addressLine1: input.address,
          city: input.city,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: request.auth.organizationId,
          actorUserId: request.auth.userId,
          action: 'PROPERTY_UPDATED',
          entityType: 'Property',
          entityId: id,
          after: { ...input },
        },
      });
      return { updated: true };
    });
  }
  @Roles('OWNER', 'MANAGER')
  @Patch('tenants/:id')
  updateTenant(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: TenantDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.tenant.findFirst({
        where: { id, organizationId: request.auth.organizationId },
      });
      if (!before) throw new Error('RESOURCE_NOT_FOUND');
      await tx.tenant.update({
        where: { id },
        data: {
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          email: input.email?.trim().toLowerCase() ?? null,
          phone: input.phone?.trim() ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: request.auth.organizationId,
          actorUserId: request.auth.userId,
          action: 'TENANT_UPDATED',
          entityType: 'Tenant',
          entityId: id,
          after: { ...input },
        },
      });
      return { updated: true };
    });
  }
  @Roles('OWNER', 'MANAGER')
  @Post('rental-setup')
  createRental(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() input: RentalSetupDto,
  ) {
    return this.setup.create(
      request.auth.organizationId,
      request.auth.userId,
      this.requireKey(key),
      input,
    );
  }
  @Get('dashboard') dashboard(@Req() request: AuthenticatedRequest) {
    return this.store.dashboard(request.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER', 'MAINTENANCE')
  @Get('properties')
  async properties(@Req() request: AuthenticatedRequest) {
    const properties = await this.store.listProperties(
      request.auth.organizationId,
    );
    if (request.auth.role !== 'MAINTENANCE') return properties;
    return (properties as Array<{ id: string; name: string }>).map((p) => ({
      id: p.id,
      name: p.name,
    }));
  }
  @Roles('OWNER', 'MANAGER')
  @Post('properties')
  createProperty(
    @Req() request: AuthenticatedRequest,
    @Body() input: PropertyDto,
  ) {
    return this.store.createProperty(request.auth.organizationId, input);
  }
  @Roles('OWNER', 'MANAGER')
  @Post('properties/:propertyId/units')
  createUnit(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') propertyId: string,
    @Body() input: UnitDto,
  ) {
    return this.store.createUnit(
      request.auth.organizationId,
      propertyId,
      input,
    );
  }
  @Get('tenants') tenants(@Req() request: AuthenticatedRequest) {
    return this.store.listTenants(request.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER')
  @Post('tenants')
  createTenant(@Req() request: AuthenticatedRequest, @Body() input: TenantDto) {
    return this.store.createTenant(request.auth.organizationId, input);
  }
  @Get('leases') leases(@Req() request: AuthenticatedRequest) {
    return this.store.listLeases(request.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER')
  @Post('leases')
  createLease(@Req() request: AuthenticatedRequest, @Body() input: LeaseDto) {
    return this.store.createLease(request.auth.organizationId, input);
  }
  @Get('charges') charges(@Req() request: AuthenticatedRequest) {
    return this.store.listCharges(request.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER')
  @Post('charges')
  createCharge(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() input: ChargeDto,
  ) {
    return this.store.createCharge(
      request.auth.organizationId,
      input,
      this.requireKey(key),
      request.auth.userId,
    );
  }
  @Get('payments') payments(@Req() request: AuthenticatedRequest) {
    return this.store.listPayments(request.auth.organizationId);
  }
  @Roles('OWNER', 'MANAGER', 'COLLECTOR')
  @Post('payments')
  createPayment(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() input: PaymentDto,
  ) {
    return this.store.createPayment(
      request.auth.organizationId,
      input,
      this.requireKey(key),
      request.auth.userId,
    );
  }
  @Get('leases/:leaseId/ledger') ledger(
    @Req() request: AuthenticatedRequest,
    @Param('leaseId') leaseId: string,
  ) {
    return this.store.ledgerForLease(request.auth.organizationId, leaseId);
  }
  private requireKey(key?: string): string {
    if (!key || key.length < 8 || key.length > 100)
      throw new Error('INVALID_IDEMPOTENCY_KEY');
    return key;
  }
}
