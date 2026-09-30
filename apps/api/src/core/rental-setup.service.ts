import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service.js';
import type { RentalSetupDto } from './flow.controller.js';

@Injectable()
export class RentalSetupService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizationId: string,
    actorUserId: string,
    key: string,
    input: RentalSetupDto,
  ) {
    const rent = this.money(input.lease.monthlyRent);
    const defaultRent = this.money(input.unit.monthlyRent);
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.charge.billingPeriod) ||
      input.charge.billingPeriod !== input.lease.startDate.slice(0, 7)
    ) {
      throw new BadRequestException(
        'First billing period must match the move-in month.',
      );
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const cached = async () => {
      const prior = await this.prisma.idempotencyKey.findUnique({
        where: {
          organizationId_key_operation: {
            organizationId,
            key,
            operation: 'RENTAL_SETUP',
          },
        },
      });
      if (
        prior &&
        (prior.operation !== 'RENTAL_SETUP' ||
          prior.requestHash !== requestHash)
      )
        throw new ConflictException(
          'This request key was already used for different rental details.',
        );
      return prior?.responseBody;
    };
    const prior = await cached();
    if (prior) return prior;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const property = await tx.property.create({
          data: {
            organizationId,
            name: input.property.name.trim(),
            type: input.property.type,
            addressLine1: input.property.address,
            city: input.property.city,
            province: input.property.city,
          },
        });
        const unit = await tx.unit.create({
          data: {
            organizationId,
            propertyId: property.id,
            number: input.unit.number,
            type: input.unit.type,
          },
        });
        const space = await tx.rentableSpace.create({
          data: {
            organizationId,
            unitId: unit.id,
            label: input.unit.number,
            defaultRent,
            status: 'UNAVAILABLE',
          },
        });
        const tenant = await tx.tenant.create({
          data: { organizationId, ...input.tenant, status: 'ACTIVE' },
        });
        const startsOn = new Date(input.lease.startDate);
        startsOn.setUTCMonth(startsOn.getUTCMonth() + 1, 1);
        const lease = await tx.lease.create({
          data: {
            organizationId,
            rentableSpaceId: space.id,
            primaryTenantId: tenant.id,
            startDate: new Date(input.lease.startDate),
            monthlyRent: rent,
            billingDay: input.lease.billingDay,
            dueDay: input.lease.dueDay,
            status: 'ACTIVE',
            activatedAt: new Date(),
            occupants: {
              create: {
                tenantId: tenant.id,
                moveInAt: new Date(input.lease.startDate),
              },
            },
            billingSchedules: {
              create: {
                organizationId,
                chargeType: 'RENT',
                description: 'Monthly rent',
                amount: rent,
                billingDay: input.lease.billingDay,
                dueDay: input.lease.dueDay,
                startsOn,
              },
            },
          },
        });
        const charge = await tx.charge.create({
          data: {
            organizationId,
            leaseId: lease.id,
            type: 'RENT',
            description: input.charge.description,
            amount: rent,
            dueDate: new Date(input.charge.dueDate),
            billingPeriod: input.charge.billingPeriod,
            status: 'POSTED',
            postedAt: new Date(),
          },
        });
        await tx.ledgerEntry.create({
          data: {
            organizationId,
            leaseId: lease.id,
            chargeId: charge.id,
            type: 'CHARGE',
            debit: rent,
            occurredAt: new Date(),
          },
        });
        const response = {
          propertyId: property.id,
          unitId: unit.id,
          tenantId: tenant.id,
          leaseId: lease.id,
          chargeId: charge.id,
        };
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId,
            action: 'RENTAL_SETUP_CREATED',
            entityType: 'Lease',
            entityId: lease.id,
            after: response,
          },
        });
        await tx.idempotencyKey.create({
          data: {
            organizationId,
            key,
            operation: 'RENTAL_SETUP',
            requestHash,
            responseBody: response,
            responseCode: 201,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
        return response;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const result = await cached();
        if (result) return result;
      }
      throw error;
    }
  }

  private money(value: string) {
    if (
      !/^\d+(\.\d{1,2})?$/.test(value) ||
      !new Prisma.Decimal(value).greaterThan(0)
    )
      throw new BadRequestException(
        'Rent must be a positive amount with at most two decimal places.',
      );
    return new Prisma.Decimal(value);
  }
}
