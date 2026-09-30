import { Injectable } from '@nestjs/common';
import { Prisma, type MembershipRole } from '@prisma/client';
import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { SessionContext } from './domain.store.js';
import type { DomainService } from './domain-service.js';
import { PrismaService } from './prisma.service.js';

const scrypt = promisify(nodeScrypt);
const sessionLifetime = 8 * 60 * 60 * 1000;

@Injectable()
export class PrismaDomainService implements DomainService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }) {
    const email = input.email.trim().toLocaleLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new Error('EMAIL_EXISTS');
    const passwordHash = await this.hashPassword(input.password);
    const slug = await this.uniqueSlug(input.organizationName);
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetime);
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, displayName: input.name.trim(), passwordHash },
      });
      const organization = await tx.organization.create({
        data: {
          name: input.organizationName.trim(),
          slug,
          receiptPrefix: slug.toUpperCase().slice(0, 4),
          receiptSequence: { create: {} },
        },
      });
      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: 'OWNER',
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
      });
      await tx.session.create({
        data: {
          tokenHash: this.tokenHash(rawToken),
          csrfToken,
          userId: user.id,
          organizationId: organization.id,
          role: 'OWNER',
          expiresAt,
        },
      });
      return { user, organization };
    });
    return {
      ...result,
      session: {
        sessionId: rawToken,
        csrfToken,
        userId: result.user.id,
        organizationId: result.organization.id,
        role: 'OWNER' as const,
        expiresAt,
      },
    };
  }

  async login(emailInput: string, password: string, workspace?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: emailInput.trim().toLocaleLowerCase() },
    });
    if (
      !user ||
      user.disabledAt ||
      !(await this.verifyPassword(password, user.passwordHash))
    )
      return undefined;
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: user.id,
        status: 'ACTIVE',
        organization: {
          status: 'ACTIVE',
          ...(workspace ? { slug: workspace } : {}),
        },
      },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) return undefined;
    const session = await this.createSession(
      user.id,
      membership.organizationId,
      membership.role,
    );
    return { user, organization: membership.organization, session };
  }

  async getSession(id?: string): Promise<SessionContext | undefined> {
    if (!id) return undefined;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.tokenHash(id) },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date())
      return undefined;
    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: session.userId,
        organizationId: session.organizationId,
        status: 'ACTIVE',
        user: { disabledAt: null },
        organization: { status: 'ACTIVE' },
      },
    });
    if (!membership) return undefined;
    return {
      sessionId: id,
      csrfToken: session.csrfToken,
      userId: session.userId,
      organizationId: session.organizationId,
      role: membership.role as SessionContext['role'],
      expiresAt: session.expiresAt,
    };
  }

  async logout(id: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: this.tokenHash(id), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async profile(context: SessionContext) {
    const membership = await this.prisma.membership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: context.organizationId,
          userId: context.userId,
        },
      },
      include: { user: true, organization: true },
    });
    if (!membership || membership.status !== 'ACTIVE')
      throw new Error('SESSION_INVALID');
    return {
      user: {
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.displayName,
      },
      organization: this.organizationView(membership.organization),
      role: membership.role,
      csrfToken: context.csrfToken,
    };
  }

  async listProperties(organizationId: string) {
    const properties = await this.prisma.property.findMany({
      where: { organizationId },
      include: {
        units: {
          include: { spaces: { orderBy: { createdAt: 'asc' }, take: 1 } },
        },
      },
      orderBy: { name: 'asc' },
    });
    return properties.map((property) => ({
      id: property.id,
      organizationId,
      name: property.name,
      type: property.type,
      address: property.addressLine1,
      city: property.city,
      units: property.units.map((unit) => ({
        id: unit.id,
        organizationId,
        propertyId: property.id,
        number: unit.number,
        type: unit.type,
        monthlyRent: this.money(unit.spaces[0]?.defaultRent ?? 0),
        status:
          unit.spaces[0]?.status === 'AVAILABLE' ? 'AVAILABLE' : 'OCCUPIED',
      })),
    }));
  }

  async createProperty(
    organizationId: string,
    input: { name: string; type: string; address: string; city: string },
  ) {
    const property = await this.prisma.property.create({
      data: {
        organizationId,
        name: input.name.trim(),
        type: input.type.trim(),
        addressLine1: input.address.trim(),
        city: input.city.trim(),
        province: input.city.trim(),
      },
    });
    return {
      id: property.id,
      organizationId,
      name: property.name,
      type: property.type,
      address: property.addressLine1,
      city: property.city,
    };
  }

  async createUnit(
    organizationId: string,
    propertyId: string,
    input: { number: string; type: string; monthlyRent: string },
  ) {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, organizationId },
    });
    if (!property) throw new Error('PROPERTY_NOT_FOUND');
    const amount = this.decimal(input.monthlyRent);
    try {
      const unit = await this.prisma.unit.create({
        data: {
          organizationId,
          propertyId,
          number: input.number.trim(),
          type: input.type.trim(),
          spaces: {
            create: {
              organizationId,
              label: 'Whole unit',
              defaultRent: amount,
            },
          },
        },
        include: { spaces: true },
      });
      return {
        id: unit.id,
        organizationId,
        propertyId,
        number: unit.number,
        type: unit.type,
        monthlyRent: this.money(amount),
        status: 'AVAILABLE',
      };
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new Error('UNIT_EXISTS');
      throw error;
    }
  }

  async listTenants(organizationId: string) {
    const tenants = await this.prisma.tenant.findMany({
      where: { organizationId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    return Promise.all(
      tenants.map(async (tenant) => ({
        id: tenant.id,
        organizationId,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        ...(tenant.email ? { email: tenant.email } : {}),
        ...(tenant.phone ? { phone: tenant.phone } : {}),
        balance: this.money(
          await this.tenantBalance(organizationId, tenant.id),
        ),
      })),
    );
  }

  async createTenant(
    organizationId: string,
    input: {
      firstName: string;
      lastName: string;
      email?: string;
      phone?: string;
    },
  ) {
    const tenant = await this.prisma.tenant.create({
      data: {
        organizationId,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email?.trim().toLocaleLowerCase(),
        phone: input.phone?.trim(),
        status: 'ACTIVE',
      },
    });
    return {
      id: tenant.id,
      organizationId,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      email: tenant.email,
      phone: tenant.phone,
      balance: '0.00',
    };
  }

  async listLeases(organizationId: string) {
    const leases = await this.prisma.lease.findMany({
      where: { organizationId },
      include: {
        primaryTenant: true,
        rentableSpace: { include: { unit: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return leases.map((lease) => this.leaseView(lease));
  }

  async createLease(
    organizationId: string,
    input: {
      unitId: string;
      tenantId: string;
      startDate: string;
      endDate?: string;
      monthlyRent: string;
      billingDay: number;
      dueDay: number;
    },
  ) {
    const monthlyRent = this.decimal(input.monthlyRent);
    if (input.endDate && new Date(input.endDate) <= new Date(input.startDate))
      throw new Error('INVALID_LEASE_DATES');
    const scheduleStart = new Date(input.startDate);
    scheduleStart.setUTCMonth(scheduleStart.getUTCMonth() + 1, 1);
    const [space, tenant] = await Promise.all([
      this.prisma.rentableSpace.findFirst({
        where: { unitId: input.unitId, organizationId },
        include: {
          leases: {
            where: { status: 'ACTIVE' },
            select: { id: true },
            take: 1,
          },
        },
      }),
      this.prisma.tenant.findFirst({
        where: { id: input.tenantId, organizationId },
      }),
    ]);
    if (!space || !tenant) throw new Error('RESOURCE_NOT_FOUND');
    if (space.leases.length) throw new Error('UNIT_OCCUPIED');
    const lease = await this.prisma.$transaction(
      async (tx) => {
        const available = await tx.rentableSpace.updateMany({
          where: { id: space.id, status: 'AVAILABLE' },
          data: { status: 'UNAVAILABLE' },
        });
        if (available.count !== 1) throw new Error('UNIT_OCCUPIED');
        const created = await tx.lease.create({
          data: {
            organizationId,
            rentableSpaceId: space.id,
            primaryTenantId: tenant.id,
            startDate: new Date(input.startDate),
            endDate: input.endDate ? new Date(input.endDate) : undefined,
            monthlyRent,
            billingDay: input.billingDay,
            dueDay: input.dueDay,
            status: 'ACTIVE',
            activatedAt: new Date(),
            occupants: {
              create: {
                tenantId: tenant.id,
                moveInAt: new Date(input.startDate),
              },
            },
            billingSchedules: {
              create: {
                organizationId,
                chargeType: 'RENT',
                description: 'Monthly rent',
                amount: monthlyRent,
                billingDay: input.billingDay,
                dueDay: input.dueDay,
                startsOn: scheduleStart,
                endsOn: input.endDate ? new Date(input.endDate) : undefined,
              },
            },
          },
          include: {
            primaryTenant: true,
            rentableSpace: { include: { unit: true } },
          },
        });
        await tx.rentableSpace.update({
          where: { id: space.id },
          data: { status: 'UNAVAILABLE' },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.leaseView(lease);
  }

  async listCharges(organizationId: string) {
    const charges = await this.prisma.charge.findMany({
      where: { organizationId },
      include: {
        allocations: { include: { payment: { select: { status: true } } } },
      },
      orderBy: { dueDate: 'desc' },
    });
    return charges.map((charge) => ({
      ...this.chargeView(charge),
      outstanding: this.money(
        charge.amount.minus(
          charge.allocations
            .filter((item) => item.payment.status === 'POSTED')
            .reduce(
              (sum, item) => sum.plus(item.amount),
              new Prisma.Decimal(0),
            ),
        ),
      ),
    }));
  }

  async createCharge(
    organizationId: string,
    input: {
      leaseId: string;
      type: string;
      description: string;
      amount: string;
      dueDate: string;
      billingPeriod?: string;
    },
    idempotencyKey: string,
    actorUserId?: string,
  ) {
    const requestHash = this.requestHash(input);
    const cached = await this.cached(
      organizationId,
      idempotencyKey,
      'CREATE_CHARGE',
      requestHash,
    );
    if (cached) return cached;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const lease = await tx.lease.findFirst({
            where: { id: input.leaseId, organizationId, status: 'ACTIVE' },
          });
          if (!lease) throw new Error('LEASE_NOT_FOUND');
          if (input.billingPeriod) {
            const duplicate = await tx.charge.findFirst({
              where: {
                leaseId: input.leaseId,
                type: input.type as never,
                billingPeriod: input.billingPeriod,
              },
            });
            if (duplicate) throw new Error('CHARGE_EXISTS');
          }
          const now = new Date();
          const charge = await tx.charge.create({
            data: {
              organizationId,
              leaseId: input.leaseId,
              type: input.type as never,
              description: input.description.trim(),
              amount: this.decimal(input.amount),
              dueDate: new Date(input.dueDate),
              billingPeriod: input.billingPeriod,
              status: 'POSTED',
              postedAt: now,
            },
          });
          await tx.ledgerEntry.create({
            data: {
              organizationId,
              leaseId: input.leaseId,
              chargeId: charge.id,
              type: 'CHARGE',
              debit: charge.amount,
              occurredAt: now,
            },
          });
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId,
              action: 'CHARGE_POSTED',
              entityType: 'Charge',
              entityId: charge.id,
              after: this.chargeView(charge),
            },
          });
          const response = this.chargeView(charge);
          await tx.idempotencyKey.create({
            data: {
              organizationId,
              key: idempotencyKey,
              operation: 'CREATE_CHARGE',
              requestHash,
              responseCode: 201,
              responseBody: response,
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          });
          return response;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const retry = await this.cached(
          organizationId,
          idempotencyKey,
          'CREATE_CHARGE',
          requestHash,
        );
        if (retry) return retry;
      }
      throw error;
    }
  }

  async listPayments(organizationId: string) {
    const payments = await this.prisma.payment.findMany({
      where: { organizationId },
      include: {
        allocations: true,
        receipts: { where: { voidedAt: null }, take: 1 },
      },
      orderBy: { paidAt: 'desc' },
    });
    return payments.map((payment) => this.paymentView(payment));
  }

  async createPayment(
    organizationId: string,
    input: {
      tenantId: string;
      leaseId: string;
      amount: string;
      method: string;
      referenceNumber?: string;
      paidAt: string;
      allocations: Array<{ chargeId: string; amount: string }>;
    },
    idempotencyKey: string,
    actorUserId?: string,
  ) {
    const requestHash = this.requestHash(input);
    const cached = await this.cached(
      organizationId,
      idempotencyKey,
      'CREATE_PAYMENT',
      requestHash,
    );
    if (cached) return cached;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const lease = await tx.lease.findFirst({
            where: {
              id: input.leaseId,
              organizationId,
              primaryTenantId: input.tenantId,
            },
          });
          if (!lease) throw new Error('LEASE_NOT_FOUND');
          const amount = this.decimal(input.amount);
          const allocations = input.allocations.map((item) => ({
            chargeId: item.chargeId,
            amount: this.decimal(item.amount),
          }));
          const allocatedTotal = allocations.reduce(
            (sum, item) => sum.plus(item.amount),
            new Prisma.Decimal(0),
          );
          if (allocatedTotal.greaterThan(amount))
            throw new Error('ALLOCATION_EXCEEDS_PAYMENT');
          for (const allocation of allocations) {
            const charge = await tx.charge.findFirst({
              where: {
                id: allocation.chargeId,
                organizationId,
                leaseId: lease.id,
              },
              include: {
                allocations: {
                  include: { payment: { select: { status: true } } },
                },
              },
            });
            if (!charge) throw new Error('INVALID_ALLOCATION');
            const used = charge.allocations
              .filter((item) => item.payment.status === 'POSTED')
              .reduce(
                (sum, item) => sum.plus(item.amount),
                new Prisma.Decimal(0),
              );
            if (allocation.amount.greaterThan(charge.amount.minus(used)))
              throw new Error('INVALID_ALLOCATION');
          }
          const sequence = await tx.receiptSequence.update({
            where: { organizationId },
            data: { nextNumber: { increment: 1 } },
          });
          const organization = await tx.organization.findUniqueOrThrow({
            where: { id: organizationId },
          });
          const receiptNumber = `${organization.receiptPrefix}-${new Date(input.paidAt).getUTCFullYear()}-${String(sequence.nextNumber - 1n).padStart(6, '0')}`;
          const payment = await tx.payment.create({
            data: {
              organizationId,
              tenantId: input.tenantId,
              leaseId: input.leaseId,
              amount,
              method: input.method as never,
              referenceNumber: input.referenceNumber?.trim(),
              paidAt: new Date(input.paidAt),
              status: 'POSTED',
              recordedBy:
                actorUserId ??
                (
                  await tx.membership.findFirstOrThrow({
                    where: { organizationId, role: 'OWNER' },
                  })
                ).userId,
              postedAt: new Date(),
              allocations: { create: allocations },
              receipts: {
                create: {
                  organizationId,
                  number: receiptNumber,
                  issuedAt: new Date(),
                },
              },
            },
            include: { allocations: true, receipts: true },
          });
          await tx.ledgerEntry.create({
            data: {
              organizationId,
              leaseId: input.leaseId,
              paymentId: payment.id,
              type: 'PAYMENT',
              credit: amount,
              occurredAt: new Date(input.paidAt),
            },
          });
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId,
              action: 'PAYMENT_POSTED',
              entityType: 'Payment',
              entityId: payment.id,
              after: this.paymentView(payment),
            },
          });
          const response = this.paymentView(payment);
          await tx.idempotencyKey.create({
            data: {
              organizationId,
              key: idempotencyKey,
              operation: 'CREATE_PAYMENT',
              requestHash,
              responseCode: 201,
              responseBody: response,
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          });
          return response;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const retry = await this.cached(
          organizationId,
          idempotencyKey,
          'CREATE_PAYMENT',
          requestHash,
        );
        if (retry) return retry;
      }
      throw error;
    }
  }

  async ledgerForLease(organizationId: string, leaseId: string) {
    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId },
      select: { id: true },
    });
    if (!lease) throw new Error('LEASE_NOT_FOUND');
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { organizationId, leaseId },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });
    let balance = new Prisma.Decimal(0);
    return entries.map((entry) => {
      balance = balance.plus(entry.debit).minus(entry.credit);
      return {
        ...entry,
        debit: this.money(entry.debit),
        credit: this.money(entry.credit),
        balance: this.money(balance),
      };
    });
  }

  async dashboard(organizationId: string) {
    const [charges, payments, spaces, activeLeases] = await Promise.all([
      this.prisma.charge.aggregate({
        where: { organizationId, status: 'POSTED' },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { organizationId, status: 'POSTED' },
        _sum: { amount: true },
      }),
      this.prisma.rentableSpace.findMany({
        where: { organizationId },
        select: { status: true },
      }),
      this.prisma.lease.count({ where: { organizationId, status: 'ACTIVE' } }),
    ]);
    const expected = charges._sum.amount ?? new Prisma.Decimal(0);
    const collected = payments._sum.amount ?? new Prisma.Decimal(0);
    return {
      expected: this.money(expected),
      collected: this.money(collected),
      outstanding: this.money(Prisma.Decimal.max(expected.minus(collected), 0)),
      activeLeases,
      occupiedUnits: spaces.filter((space) => space.status !== 'AVAILABLE')
        .length,
      totalUnits: spaces.length,
      collectionRate: expected.isZero()
        ? 0
        : Number(collected.div(expected).mul(100).toFixed(1)),
    };
  }

  private async createSession(
    userId: string,
    organizationId: string,
    role: MembershipRole,
  ): Promise<SessionContext> {
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetime);
    await this.prisma.session.create({
      data: {
        tokenHash: this.tokenHash(sessionId),
        csrfToken,
        userId,
        organizationId,
        role,
        expiresAt,
      },
    });
    return {
      sessionId,
      csrfToken,
      userId,
      organizationId,
      role: role as SessionContext['role'],
      expiresAt,
    };
  }

  private async cached(
    organizationId: string,
    key: string,
    operation: string,
    expectedHash?: string,
  ) {
    const record = await this.prisma.idempotencyKey.findUnique({
      where: {
        organizationId_key_operation: { organizationId, key, operation },
      },
    });
    if (!record?.responseBody) return undefined;
    if (expectedHash && record.requestHash !== expectedHash)
      throw new Error('IDEMPOTENCY_CONFLICT');
    return record.responseBody;
  }

  private async tenantBalance(organizationId: string, tenantId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { organizationId, payment: { tenantId } },
      select: { debit: true, credit: true },
    });
    const leaseEntries = await this.prisma.ledgerEntry.findMany({
      where: {
        organizationId,
        paymentId: null,
        charge: { lease: { primaryTenantId: tenantId } },
      },
      select: { debit: true, credit: true },
    });
    return [...entries, ...leaseEntries].reduce(
      (sum, entry) => sum.plus(entry.debit).minus(entry.credit),
      new Prisma.Decimal(0),
    );
  }

  private leaseView(lease: any) {
    return {
      id: lease.id,
      organizationId: lease.organizationId,
      unitId: lease.rentableSpace.unit.id,
      tenantId: lease.primaryTenantId,
      startDate: this.date(lease.startDate),
      ...(lease.endDate ? { endDate: this.date(lease.endDate) } : {}),
      monthlyRent: this.money(lease.monthlyRent),
      billingDay: lease.billingDay,
      dueDay: lease.dueDay,
      status: lease.status,
      tenant: lease.primaryTenant,
      unit: {
        id: lease.rentableSpace.unit.id,
        number: lease.rentableSpace.unit.number,
        type: lease.rentableSpace.unit.type,
      },
    };
  }
  private chargeView(charge: any) {
    return {
      id: charge.id,
      organizationId: charge.organizationId,
      leaseId: charge.leaseId,
      type: charge.type,
      description: charge.description,
      amount: this.money(charge.amount),
      dueDate: this.date(charge.dueDate),
      ...(charge.billingPeriod ? { billingPeriod: charge.billingPeriod } : {}),
      status: charge.status,
      createdAt: charge.createdAt.toISOString(),
    };
  }
  private paymentView(payment: any) {
    return {
      id: payment.id,
      organizationId: payment.organizationId,
      tenantId: payment.tenantId,
      leaseId: payment.leaseId,
      amount: this.money(payment.amount),
      method: payment.method,
      referenceNumber: payment.referenceNumber,
      paidAt: payment.paidAt.toISOString(),
      status: payment.status,
      receiptNumber: payment.receipts[0]?.number,
      createdAt: payment.createdAt.toISOString(),
      allocations: payment.allocations.map((item: any) => ({
        id: item.id,
        paymentId: item.paymentId,
        chargeId: item.chargeId,
        amount: this.money(item.amount),
      })),
    };
  }
  private organizationView(organization: any) {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      currency: organization.currency,
      timezone: organization.timezone,
    };
  }
  private date(value: Date) {
    return value.toISOString().slice(0, 10);
  }
  private decimal(value: string) {
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('INVALID_MONEY');
    const amount = new Prisma.Decimal(value);
    if (!amount.greaterThan(0)) throw new Error('INVALID_MONEY');
    return amount;
  }
  private money(value: Prisma.Decimal.Value) {
    return new Prisma.Decimal(value).toFixed(2);
  }
  private tokenHash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  private requestHash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private isUniqueViolation(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
  private async uniqueSlug(name: string) {
    const base =
      name
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'organization';
    if (
      !(await this.prisma.organization.findUnique({
        where: { slug: base },
        select: { id: true },
      }))
    )
      return base;
    return `${base}-${randomBytes(3).toString('hex')}`;
  }
  private async hashPassword(password: string) {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `${salt.toString('hex')}:${derived.toString('hex')}`;
  }
  private async verifyPassword(password: string, stored: string) {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const hash = Buffer.from(hashHex, 'hex');
    const derived = (await scrypt(
      password,
      Buffer.from(saltHex, 'hex'),
      hash.length,
    )) as Buffer;
    return timingSafeEqual(hash, derived);
  }
}
