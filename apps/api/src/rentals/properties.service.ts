import { Injectable } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';
import { audit } from '../common/audit.js';
import { DomainError, notFound } from '../common/errors.js';
import { formatMoney, parseMoney } from '../common/money.js';
import { isUniqueViolation, PrismaService } from '../common/prisma.service.js';

export interface PropertyInput {
  name: string;
  type: string;
  address: string;
  city: string;
}
export interface UnitInput {
  number: string;
  type: string;
  monthlyRent: string;
}

@Injectable()
export class PropertiesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, role: MembershipRole) {
    const properties = await this.prisma.property.findMany({
      where: { organizationId },
      include: {
        units: {
          orderBy: { number: 'asc' },
          include: {
            spaces: {
              orderBy: { createdAt: 'asc' },
              include: {
                leases: {
                  where: { status: 'ACTIVE' },
                  select: { id: true, monthlyRent: true, primaryTenantId: true },
                },
              },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    // Maintenance staff only need property names to file work orders.
    if (role === 'MAINTENANCE')
      return properties.map((property) => ({
        id: property.id,
        name: property.name,
        units: property.units.map((unit) => ({ id: unit.id, number: unit.number })),
      }));
    return properties.map((property) => ({
      id: property.id,
      name: property.name,
      type: property.type,
      address: property.addressLine1,
      city: property.city,
      status: property.status,
      units: property.units.map((unit) => {
        const space = unit.spaces[0];
        const lease = unit.spaces.flatMap((item) => item.leases)[0];
        return {
          id: unit.id,
          propertyId: property.id,
          number: unit.number,
          type: unit.type,
          monthlyRent: formatMoney(space?.defaultRent ?? 0),
          status: lease ? 'OCCUPIED' : space?.status === 'AVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE',
          activeLeaseId: lease?.id ?? null,
          activeRent: lease ? formatMoney(lease.monthlyRent) : null,
        };
      }),
    }));
  }

  async create(organizationId: string, actorUserId: string, input: PropertyInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const property = await tx.property.create({
          data: {
            organizationId,
            name: input.name.trim(),
            type: input.type.trim(),
            addressLine1: input.address.trim(),
            city: input.city.trim(),
            province: input.city.trim(),
          },
        });
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'PROPERTY_CREATED',
          entityType: 'Property',
          entityId: property.id,
          after: property,
        });
        return {
          id: property.id,
          name: property.name,
          type: property.type,
          address: property.addressLine1,
          city: property.city,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('PROPERTY_EXISTS', 409);
      throw error;
    }
  }

  async update(organizationId: string, actorUserId: string, id: string, input: PropertyInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.property.findFirst({ where: { id, organizationId } });
        if (!before) throw notFound('PROPERTY_NOT_FOUND');
        const after = await tx.property.update({
          where: { id },
          data: {
            name: input.name.trim(),
            type: input.type.trim(),
            addressLine1: input.address.trim(),
            city: input.city.trim(),
          },
        });
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'PROPERTY_UPDATED',
          entityType: 'Property',
          entityId: id,
          before,
          after,
        });
        return { updated: true };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('PROPERTY_EXISTS', 409);
      throw error;
    }
  }

  async createUnit(organizationId: string, actorUserId: string, propertyId: string, input: UnitInput) {
    const defaultRent = parseMoney(input.monthlyRent);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const property = await tx.property.findFirst({ where: { id: propertyId, organizationId } });
        if (!property) throw notFound('PROPERTY_NOT_FOUND');
        const unit = await tx.unit.create({
          data: {
            organizationId,
            propertyId,
            number: input.number.trim(),
            type: input.type.trim(),
            spaces: { create: { organizationId, label: 'Whole unit', defaultRent } },
          },
        });
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'UNIT_CREATED',
          entityType: 'Unit',
          entityId: unit.id,
          after: { ...unit, defaultRent },
        });
        return {
          id: unit.id,
          propertyId,
          number: unit.number,
          type: unit.type,
          monthlyRent: formatMoney(defaultRent),
          status: 'AVAILABLE',
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('UNIT_EXISTS', 409);
      throw error;
    }
  }

  async updateUnit(organizationId: string, actorUserId: string, id: string, input: UnitInput) {
    const defaultRent = parseMoney(input.monthlyRent);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.unit.findFirst({
          where: { id, organizationId },
          include: { spaces: { orderBy: { createdAt: 'asc' }, take: 1 } },
        });
        if (!before) throw notFound();
        await tx.unit.update({
          where: { id },
          data: { number: input.number.trim(), type: input.type.trim() },
        });
        // The default rent applies to new leases; active leases keep their rent.
        if (before.spaces[0])
          await tx.rentableSpace.update({ where: { id: before.spaces[0].id }, data: { defaultRent } });
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'UNIT_UPDATED',
          entityType: 'Unit',
          entityId: id,
          before,
          after: { ...input },
        });
        return { updated: true };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainError('UNIT_EXISTS', 409);
      throw error;
    }
  }
}
