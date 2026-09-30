import { Injectable } from '@nestjs/common';
import { audit } from '../common/audit.js';
import { periodOf } from '../common/dates.js';
import { DomainError } from '../common/errors.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { parseMoney } from '../common/money.js';
import { createLeaseInTx, type FirstMonthMode } from './leases.service.js';

export interface RentalSetupInput {
  property: { name: string; type: string; address: string; city: string };
  unit: { number: string; type: string; monthlyRent: string };
  tenant: { firstName: string; lastName: string; email?: string; phone?: string };
  lease: {
    startDate: string;
    endDate?: string;
    monthlyRent: string;
    billingDay: number;
    dueDay: number;
    gracePeriodDays?: number;
    depositRequired?: string;
    firstMonth?: FirstMonthMode;
  };
  charge: { description: string; dueDate: string; billingPeriod: string };
}

/** Guided setup: property, unit, tenant, lease, and first charge atomically. */
@Injectable()
export class RentalSetupService {
  constructor(private readonly idempotency: IdempotencyService) {}

  async create(organizationId: string, actorUserId: string, key: string, input: RentalSetupInput) {
    const rent = parseMoney(input.lease.monthlyRent);
    const defaultRent = parseMoney(input.unit.monthlyRent);
    const depositRequired = input.lease.depositRequired
      ? parseMoney(input.lease.depositRequired, { allowZero: true })
      : undefined;
    if (input.charge.billingPeriod !== periodOf(input.lease.startDate))
      throw new DomainError('INVALID_LEASE_DATES', 400, 'First billing period must match the move-in month.');
    return this.idempotency.execute(
      { organizationId, key, operation: 'RENTAL_SETUP' },
      input,
      async (tx) => {
        const property =
          (await tx.property.findFirst({ where: { organizationId, name: input.property.name.trim() } })) ??
          (await tx.property.create({
            data: {
              organizationId,
              name: input.property.name.trim(),
              type: input.property.type.trim(),
              addressLine1: input.property.address.trim(),
              city: input.property.city.trim(),
              province: input.property.city.trim(),
            },
          }));
        if (await tx.unit.findFirst({ where: { propertyId: property.id, number: input.unit.number.trim() } }))
          throw new DomainError('UNIT_EXISTS', 409);
        const unit = await tx.unit.create({
          data: {
            organizationId,
            propertyId: property.id,
            number: input.unit.number.trim(),
            type: input.unit.type.trim(),
            spaces: { create: { organizationId, label: 'Whole unit', defaultRent } },
          },
          include: { spaces: true },
        });
        const tenant = await tx.tenant.create({
          data: {
            organizationId,
            firstName: input.tenant.firstName.trim(),
            lastName: input.tenant.lastName.trim(),
            email: input.tenant.email?.trim().toLowerCase() || null,
            phone: input.tenant.phone?.trim() || null,
            status: 'ACTIVE',
          },
        });
        const { lease, firstChargeId } = await createLeaseInTx(tx, {
          organizationId,
          actorUserId,
          rentableSpaceId: unit.spaces[0]!.id,
          tenantId: tenant.id,
          startDate: input.lease.startDate,
          endDate: input.lease.endDate,
          monthlyRent: rent,
          billingDay: input.lease.billingDay,
          dueDay: input.lease.dueDay,
          gracePeriodDays: input.lease.gracePeriodDays,
          depositRequired,
          firstMonth: input.lease.firstMonth ?? 'FULL',
          firstChargeDueDate: input.charge.dueDate,
          firstChargeDescription: input.charge.description,
        });
        const response = {
          propertyId: property.id,
          unitId: unit.id,
          tenantId: tenant.id,
          leaseId: lease.id,
          chargeId: firstChargeId ?? null,
        };
        await audit(tx, {
          organizationId,
          actorUserId,
          action: 'RENTAL_SETUP_CREATED',
          entityType: 'Lease',
          entityId: lease.id,
          after: response,
        });
        return response;
      },
    );
  }
}
