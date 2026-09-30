import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { PrismaService } from '../core/prisma.service.js';

const scrypt = promisify(nodeScrypt);

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createBillingSchedule(
    organizationId: string,
    actorUserId: string,
    input: any,
  ) {
    const lease = await this.prisma.lease.findFirst({
      where: { id: input.leaseId, organizationId, status: 'ACTIVE' },
    });
    if (!lease) throw new Error('LEASE_NOT_FOUND');
    const schedule = await this.prisma.billingSchedule.create({
      data: {
        organizationId,
        leaseId: lease.id,
        chargeType: input.type,
        description: input.description.trim(),
        amount: this.decimal(input.amount),
        billingDay: input.billingDay,
        dueDay: input.dueDay,
        startsOn: new Date(input.startsOn),
        endsOn: input.endsOn ? new Date(input.endsOn) : undefined,
      },
    });
    await this.audit(
      organizationId,
      actorUserId,
      'BILLING_SCHEDULE_CREATED',
      'BillingSchedule',
      schedule.id,
      schedule,
    );
    return this.json(schedule);
  }

  async listBillingSchedules(organizationId: string) {
    const rows = await this.prisma.billingSchedule.findMany({
      where: { organizationId },
      include: {
        lease: {
          include: {
            primaryTenant: true,
            rentableSpace: { include: { unit: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      ...this.json(row),
      amount: this.money(row.amount),
    }));
  }

  async runBilling(
    organizationId: string,
    actorUserId: string,
    asOfInput?: string,
  ) {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: organization.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const today = `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`;
    const asOf = new Date(`${(asOfInput ?? today).slice(0, 10)}T23:59:59.999Z`);
    const period = `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, '0')}`;
    const schedules = await this.prisma.billingSchedule.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        startsOn: { lte: asOf },
        lease: { status: 'ACTIVE' },
      },
    });
    let created = 0;
    let skipped = 0;
    for (const schedule of schedules) {
      const month = new Date(
        Date.UTC(
          schedule.startsOn.getUTCFullYear(),
          schedule.startsOn.getUTCMonth(),
          1,
        ),
      );
      for (; month <= asOf; month.setUTCMonth(month.getUTCMonth() + 1)) {
        const billingDate = new Date(
          Date.UTC(
            month.getUTCFullYear(),
            month.getUTCMonth(),
            schedule.billingDay,
          ),
        );
        if (
          billingDate > asOf ||
          billingDate < schedule.startsOn ||
          (schedule.endsOn && billingDate > schedule.endsOn)
        ) {
          skipped++;
          continue;
        }
        const billingPeriod = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
        let result = false;
        try {
          result = await this.prisma.$transaction(
            async (tx) => {
              const exists = await tx.charge.findFirst({
                where: { billingScheduleId: schedule.id, billingPeriod },
              });
              if (exists) return false;
              const dueDate = new Date(
                Date.UTC(
                  month.getUTCFullYear(),
                  month.getUTCMonth(),
                  Math.min(schedule.dueDay, 28),
                ),
              );
              const charge = await tx.charge.create({
                data: {
                  organizationId,
                  leaseId: schedule.leaseId,
                  billingScheduleId: schedule.id,
                  type: schedule.chargeType,
                  description: schedule.description,
                  amount: schedule.amount,
                  billingPeriod,
                  dueDate,
                  status: 'POSTED',
                  postedAt: new Date(),
                },
              });
              await tx.ledgerEntry.create({
                data: {
                  organizationId,
                  leaseId: schedule.leaseId,
                  chargeId: charge.id,
                  type: 'CHARGE',
                  debit: charge.amount,
                  occurredAt: new Date(),
                },
              });
              await tx.auditLog.create({
                data: {
                  organizationId,
                  actorUserId,
                  action: 'SCHEDULED_CHARGE_POSTED',
                  entityType: 'Charge',
                  entityId: charge.id,
                  after: this.json(charge) as Prisma.InputJsonValue,
                },
              });
              return true;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (!(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ))
            throw error;
        }
        if (result) created++;
        else skipped++;
      }
    }
    return { period, schedules: schedules.length, created, skipped };
  }

  async terminateLease(
    organizationId: string,
    actorUserId: string,
    leaseId: string,
    input: any,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const lease = await tx.lease.findFirst({
        where: { id: leaseId, organizationId, status: 'ACTIVE' },
      });
      if (!lease) throw new Error('LEASE_NOT_FOUND');
      const ended = new Date(input.endDate);
      if (ended < lease.startDate) throw new Error('INVALID_LEASE_DATES');
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { timezone: true },
      });
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: organization.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      if (
        !Number.isFinite(ended.getTime()) ||
        ended.toISOString().slice(0, 10) > today
      )
        throw new Error('FUTURE_TERMINATION_NOT_ALLOWED');
      const updated = await tx.lease.update({
        where: { id: lease.id },
        data: {
          status: 'TERMINATED',
          endDate: ended,
          terminatedAt: new Date(),
        },
      });
      await tx.leaseOccupant.updateMany({
        where: { leaseId: lease.id, moveOutAt: null },
        data: { moveOutAt: ended },
      });
      await tx.rentableSpace.update({
        where: { id: lease.rentableSpaceId },
        data: { status: 'AVAILABLE' },
      });
      await tx.billingSchedule.updateMany({
        where: { leaseId: lease.id, status: 'ACTIVE' },
        data: { status: 'ENDED', endsOn: ended },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId,
          action: 'LEASE_TERMINATED',
          entityType: 'Lease',
          entityId: lease.id,
          before: this.json(lease) as Prisma.InputJsonValue,
          after: this.json({
            ...updated,
            reason: input.reason,
          }) as Prisma.InputJsonValue,
          reason: input.reason,
        },
      });
      return this.json(updated);
    });
  }

  async renewLease(
    organizationId: string,
    actorUserId: string,
    leaseId: string,
    input: any,
  ) {
    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId, status: 'ACTIVE' },
    });
    if (!lease) throw new Error('LEASE_NOT_FOUND');
    const newRent = input.monthlyRent
      ? this.decimal(input.monthlyRent)
      : undefined;
    if (newRent && !newRent.equals(lease.monthlyRent))
      throw new Error('RENT_CHANGE_REQUIRES_NEW_LEASE');
    if (new Date(input.endDate) <= (lease.endDate ?? lease.startDate))
      throw new Error('INVALID_LEASE_DATES');
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.lease.update({
        where: { id: lease.id },
        data: { endDate: new Date(input.endDate), monthlyRent: newRent },
      });
      await tx.billingSchedule.updateMany({
        where: { leaseId: lease.id, status: 'ACTIVE', chargeType: 'RENT' },
        data: { endsOn: new Date(input.endDate), amount: newRent },
      });
      return result;
    });
    await this.audit(
      organizationId,
      actorUserId,
      'LEASE_RENEWED',
      'Lease',
      lease.id,
      { before: lease, after: updated },
    );
    return this.json(updated);
  }

  async reversePayment(
    organizationId: string,
    actorUserId: string,
    paymentId: string,
    reason: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findFirst({
          where: { id: paymentId, organizationId, status: 'POSTED' },
        });
        if (!payment || !payment.leaseId) throw new Error('PAYMENT_NOT_FOUND');
        const reversal = await tx.paymentReversal.create({
          data: { organizationId, paymentId, reason, reversedBy: actorUserId },
        });
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'REVERSED' },
        });
        await tx.receipt.updateMany({
          where: { paymentId: payment.id, voidedAt: null },
          data: { voidedAt: new Date() },
        });
        await tx.ledgerEntry.create({
          data: {
            organizationId,
            leaseId: payment.leaseId,
            paymentId: payment.id,
            type: 'PAYMENT_REVERSAL',
            debit: payment.amount,
            occurredAt: new Date(),
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId,
            action: 'PAYMENT_REVERSED',
            entityType: 'Payment',
            entityId: payment.id,
            reason,
            after: this.json(reversal) as Prisma.InputJsonValue,
          },
        });
        return this.json({ ...reversal, amount: payment.amount });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listDeposits(organizationId: string) {
    const rows = await this.prisma.depositAccount.findMany({
      where: { organizationId },
      include: {
        lease: {
          include: {
            primaryTenant: true,
            rentableSpace: { include: { unit: true } },
          },
        },
        transactions: { orderBy: { occurredAt: 'desc' } },
      },
    });
    return rows.map((row) => ({
      ...this.json(row),
      balance: this.money(
        row.transactions.reduce(
          (sum, item) =>
            item.type === 'RECEIPT' || item.type === 'ADJUSTMENT'
              ? sum.plus(item.amount)
              : sum.minus(item.amount),
          new Prisma.Decimal(0),
        ),
      ),
    }));
  }

  async recordDeposit(
    organizationId: string,
    actorUserId: string,
    leaseId: string,
    input: any,
    key: string,
  ) {
    const requestHash = this.hash(JSON.stringify({ leaseId, ...input }));
    const cached = async () => {
      const prior = await this.prisma.idempotencyKey.findUnique({
        where: {
          organizationId_key_operation: {
            organizationId,
            key,
            operation: 'DEPOSIT',
          },
        },
      });
      if (prior && prior.requestHash !== requestHash)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return prior?.responseBody;
    };
    const prior = await cached();
    if (prior) return prior;
    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId },
    });
    if (!lease) throw new Error('LEASE_NOT_FOUND');
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const account = await tx.depositAccount.upsert({
            where: { leaseId },
            update: {},
            create: {
              organizationId,
              leaseId,
              requiredAmount: input.requiredAmount
                ? this.decimal(input.requiredAmount)
                : lease.depositRequired,
            },
            include: { transactions: true },
          });
          const amount = this.decimal(input.amount);
          const balance = account.transactions.reduce(
            (sum, item) =>
              item.type === 'RECEIPT' || item.type === 'ADJUSTMENT'
                ? sum.plus(item.amount)
                : sum.minus(item.amount),
            new Prisma.Decimal(0),
          );
          if (
            (input.type === 'DEDUCTION' || input.type === 'REFUND') &&
            amount.greaterThan(balance)
          )
            throw new Error('INVALID_DEPOSIT');
          const transaction = await tx.depositTransaction.create({
            data: {
              organizationId,
              depositAccountId: account.id,
              type: input.type,
              amount,
              reason: input.reason,
              recordedBy: actorUserId,
              occurredAt: input.occurredAt
                ? new Date(input.occurredAt)
                : new Date(),
            },
          });
          await tx.auditLog.create({
            data: {
              organizationId,
              actorUserId,
              action: `DEPOSIT_${input.type}`,
              entityType: 'DepositTransaction',
              entityId: transaction.id,
              after: this.json(transaction) as Prisma.InputJsonValue,
            },
          });
          await tx.idempotencyKey.create({
            data: {
              organizationId,
              key,
              operation: 'DEPOSIT',
              requestHash,
              responseBody: this.json(transaction),
              responseCode: 201,
              expiresAt: new Date(Date.now() + 86400000),
            },
          });
          return transaction;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return this.json(result);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        const prior = await cached();
        if (prior) return prior;
      }
      throw error;
    }
  }

  async listExpenses(organizationId: string) {
    const rows = await this.prisma.expense.findMany({
      where: { organizationId },
      include: { property: { select: { name: true } } },
      orderBy: { incurredOn: 'desc' },
    });
    return rows.map((row) => this.json(row));
  }
  async createExpense(organizationId: string, actorUserId: string, input: any) {
    if (
      input.propertyId &&
      !(await this.prisma.property.findFirst({
        where: { id: input.propertyId, organizationId },
      }))
    )
      throw new Error('PROPERTY_NOT_FOUND');
    const row = await this.prisma.expense.create({
      data: {
        organizationId,
        propertyId: input.propertyId,
        category: input.category,
        description: input.description.trim(),
        vendor: input.vendor?.trim(),
        amount: this.decimal(input.amount),
        incurredOn: new Date(input.incurredOn),
        reference: input.reference?.trim(),
        createdBy: actorUserId,
      },
      include: { property: { select: { name: true } } },
    });
    await this.audit(
      organizationId,
      actorUserId,
      'EXPENSE_CREATED',
      'Expense',
      row.id,
      row,
    );
    return this.json(row);
  }

  async listMaintenance(organizationId: string) {
    return this.prisma.maintenanceRequest.findMany({
      where: { organizationId },
      include: {
        property: { select: { name: true } },
        unit: { select: { number: true } },
      },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
    });
  }
  async createMaintenance(
    organizationId: string,
    actorUserId: string,
    input: any,
  ) {
    const property = await this.prisma.property.findFirst({
      where: { id: input.propertyId, organizationId },
    });
    if (!property) throw new Error('PROPERTY_NOT_FOUND');
    if (
      input.unitId &&
      !(await this.prisma.unit.findFirst({
        where: {
          id: input.unitId,
          organizationId,
          propertyId: input.propertyId,
        },
      }))
    )
      throw new Error('RESOURCE_NOT_FOUND');
    const row = await this.prisma.maintenanceRequest.create({
      data: {
        organizationId,
        propertyId: input.propertyId,
        unitId: input.unitId,
        title: input.title.trim(),
        description: input.description.trim(),
        priority: input.priority,
        assignedTo: input.assignedTo?.trim(),
        dueOn: input.dueOn ? new Date(input.dueOn) : undefined,
        reportedBy: actorUserId,
      },
    });
    await this.audit(
      organizationId,
      actorUserId,
      'MAINTENANCE_CREATED',
      'MaintenanceRequest',
      row.id,
      row,
    );
    return row;
  }
  async updateMaintenance(
    organizationId: string,
    actorUserId: string,
    id: string,
    input: any,
  ) {
    const row = await this.prisma.maintenanceRequest.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new Error('MAINTENANCE_NOT_FOUND');
    const updated = await this.prisma.maintenanceRequest.update({
      where: { id },
      data: {
        status: input.status,
        priority: input.priority,
        assignedTo: input.assignedTo,
        completedAt:
          input.status === 'COMPLETED'
            ? new Date()
            : input.status
              ? null
              : undefined,
      },
    });
    await this.audit(
      organizationId,
      actorUserId,
      'MAINTENANCE_UPDATED',
      'MaintenanceRequest',
      id,
      { before: row, after: updated },
    );
    return updated;
  }

  async listDocuments(organizationId: string) {
    return this.prisma.documentRecord.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }
  async createDocument(
    organizationId: string,
    actorUserId: string,
    input: any,
  ) {
    const row = await this.prisma.documentRecord.create({
      data: {
        organizationId,
        name: input.name.trim(),
        category: input.category.trim(),
        entityType: input.entityType?.trim(),
        entityId: input.entityId?.trim(),
        url: input.url.trim(),
        createdBy: actorUserId,
      },
    });
    await this.audit(
      organizationId,
      actorUserId,
      'DOCUMENT_LINKED',
      'DocumentRecord',
      row.id,
      row,
    );
    return row;
  }
  async deleteDocument(
    organizationId: string,
    actorUserId: string,
    id: string,
  ) {
    const row = await this.prisma.documentRecord.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new Error('DOCUMENT_NOT_FOUND');
    await this.prisma.documentRecord.delete({ where: { id } });
    await this.audit(
      organizationId,
      actorUserId,
      'DOCUMENT_REMOVED',
      'DocumentRecord',
      id,
      row,
    );
    return { deleted: true };
  }

  async reminders(organizationId: string) {
    const now = new Date();
    const inThirtyDays = new Date(now.getTime() + 30 * 86_400_000);
    const [charges, leases, maintenance] = await Promise.all([
      this.prisma.charge.findMany({
        where: {
          organizationId,
          status: 'POSTED',
          dueDate: { lt: now },
        },
        include: {
          lease: { include: { primaryTenant: true } },
          allocations: { include: { payment: { select: { status: true } } } },
        },
        take: 20,
      }),
      this.prisma.lease.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          endDate: { gte: now, lte: inThirtyDays },
        },
        include: { primaryTenant: true },
        take: 20,
      }),
      this.prisma.maintenanceRequest.findMany({
        where: {
          organizationId,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          OR: [
            { priority: { in: ['HIGH', 'URGENT'] } },
            { dueOn: { lte: now } },
          ],
        },
        take: 20,
      }),
    ]);
    const overdueCharges = charges.filter((item) =>
      item.allocations
        .filter((allocation) => allocation.payment.status === 'POSTED')
        .reduce(
          (sum, allocation) => sum.plus(allocation.amount),
          new Prisma.Decimal(0),
        )
        .lessThan(item.amount),
    );
    return [
      ...overdueCharges.map((item) => ({
        id: item.id,
        type: 'OVERDUE_CHARGE',
        title: `${item.lease.primaryTenant.firstName} ${item.lease.primaryTenant.lastName}`,
        detail: `${item.description} was due ${item.dueDate.toISOString().slice(0, 10)}`,
        route: '/billing',
        severity: 'high',
      })),
      ...leases.map((item) => ({
        id: item.id,
        type: 'LEASE_EXPIRY',
        title: `${item.primaryTenant.firstName} ${item.primaryTenant.lastName}`,
        detail: `Lease ends ${item.endDate?.toISOString().slice(0, 10)}`,
        route: '/leases',
        severity: 'medium',
      })),
      ...maintenance.map((item) => ({
        id: item.id,
        type: 'MAINTENANCE',
        title: item.title,
        detail: `${item.priority} priority · ${item.status}`,
        route: '/maintenance',
        severity: item.priority === 'URGENT' ? 'high' : 'medium',
      })),
    ];
  }

  async listStaff(organizationId: string) {
    const [members, invitations] = await Promise.all([
      this.prisma.membership.findMany({
        where: { organizationId },
        include: {
          user: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.staffInvitation.findMany({
        where: { organizationId, status: 'PENDING' },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      }),
    ]);
    return { members, invitations };
  }
  async inviteStaff(organizationId: string, actorUserId: string, input: any) {
    const email = input.email.trim().toLocaleLowerCase();
    if (input.role === 'OWNER') throw new Error('INVALID_ROLE');
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.staffInvitation.create({
      data: {
        organizationId,
        email,
        role: input.role,
        tokenHash: this.hash(token),
        invitedBy: actorUserId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    await this.audit(
      organizationId,
      actorUserId,
      'STAFF_INVITED',
      'StaffInvitation',
      invitation.id,
      { email, role: input.role },
    );
    return {
      id: invitation.id,
      email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      token,
    };
  }
  async acceptInvitation(input: any) {
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash: this.hash(input.token) },
      include: { organization: { select: { slug: true, status: true } } },
    });
    if (
      !invitation ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt <= new Date() ||
      invitation.organization.status !== 'ACTIVE'
    )
      throw new Error('INVITATION_INVALID');
    const existing = await this.prisma.user.findUnique({
      where: { email: invitation.email },
    });
    if (existing) {
      const [salt, stored] = existing.passwordHash.split(':');
      const expected = Buffer.from(stored, 'hex');
      const actual = (await scrypt(
        input.password,
        Buffer.from(salt, 'hex'),
        expected.length,
      )) as Buffer;
      if (existing.disabledAt || !timingSafeEqual(expected, actual))
        throw new UnauthorizedException(
          'Use the existing account password to accept this invitation.',
        );
    } else if (
      !input.name?.trim() ||
      input.name.trim().length < 2 ||
      input.password.length < 12
    ) {
      throw new Error('NAME_AND_STRONG_PASSWORD_REQUIRED');
    }
    const passwordHash =
      existing?.passwordHash ?? (await this.hashPassword(input.password));
    const user = await this.prisma.$transaction(async (tx) => {
      // Claim once inside the transaction, including expiry/revocation checks.
      const claimed = await tx.staffInvitation.updateMany({
        where: {
          id: invitation.id,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
          organization: { status: 'ACTIVE' },
        },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Error('INVITATION_INVALID');
      const created = existing
        ? await tx.user.findFirst({
            where: {
              id: existing.id,
              passwordHash: existing.passwordHash,
              disabledAt: null,
            },
          })
        : await tx.user.create({
            data: {
              email: invitation.email,
              displayName: input.name.trim(),
              passwordHash,
            },
          });
      if (!created)
        throw new UnauthorizedException(
          'Sign in again before accepting this invitation.',
        );
      const member = await tx.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: created.id,
          },
        },
      });
      // Never silently overwrite an existing role or reactivate suspended access.
      if (member) throw new Error('ALREADY_A_MEMBER');
      await tx.membership.create({
        data: {
          organizationId: invitation.organizationId,
          userId: created.id,
          role: invitation.role,
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: invitation.organizationId,
          actorUserId: created.id,
          action: 'STAFF_INVITATION_ACCEPTED',
          entityType: 'StaffInvitation',
          entityId: invitation.id,
        },
      });
      return created;
    });
    return {
      accepted: true,
      email: user.email,
      workspace: invitation.organization.slug,
    };
  }

  async financialReport(organizationId: string) {
    const [charges, payments, expenses, properties, leases] = await Promise.all(
      [
        this.prisma.charge.aggregate({
          where: { organizationId, status: 'POSTED' },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.payment.aggregate({
          where: { organizationId, status: 'POSTED' },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.expense.aggregate({
          where: { organizationId },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.property.count({
          where: { organizationId, status: 'ACTIVE' },
        }),
        this.prisma.lease.count({
          where: { organizationId, status: 'ACTIVE' },
        }),
      ],
    );
    const expected = charges._sum.amount ?? new Prisma.Decimal(0);
    const collected = payments._sum.amount ?? new Prisma.Decimal(0);
    const spent = expenses._sum.amount ?? new Prisma.Decimal(0);
    return {
      expected: this.money(expected),
      collected: this.money(collected),
      outstanding: this.money(Prisma.Decimal.max(expected.minus(collected), 0)),
      expenses: this.money(spent),
      netCash: this.money(collected.minus(spent)),
      chargeCount: charges._count,
      paymentCount: payments._count,
      expenseCount: expenses._count,
      properties,
      activeLeases: leases,
    };
  }

  async transactionsCsv(organizationId: string) {
    const [payments, expenses] = await Promise.all([
      this.prisma.payment.findMany({
        where: { organizationId },
        include: { tenant: true, receipts: true },
        orderBy: { paidAt: 'desc' },
      }),
      this.prisma.expense.findMany({
        where: { organizationId },
        orderBy: { incurredOn: 'desc' },
      }),
    ]);
    const lines = ['type,date,reference,description,amount,status'];
    for (const row of payments)
      lines.push(
        this.csv([
          'payment',
          row.paidAt.toISOString(),
          row.receipts[0]?.number ?? row.referenceNumber ?? '',
          `${row.tenant.firstName} ${row.tenant.lastName}`,
          this.money(row.amount),
          row.status,
        ]),
      );
    for (const row of expenses)
      lines.push(
        this.csv([
          'expense',
          row.incurredOn.toISOString().slice(0, 10),
          row.reference ?? '',
          row.description,
          `-${this.money(row.amount)}`,
          'POSTED',
        ]),
      );
    return lines.join('\n');
  }

  private async audit(
    organizationId: string,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    after: unknown,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        actorUserId,
        action,
        entityType,
        entityId,
        after: this.json(after) as Prisma.InputJsonValue,
      },
    });
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
  private json<T>(value: T): any {
    return JSON.parse(
      JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint'
          ? item.toString()
          : item instanceof Prisma.Decimal
            ? item.toFixed(2)
            : item,
      ),
    );
  }
  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  private csv(values: string[]) {
    return values
      .map((value) => {
        const text = String(value);
        return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
      })
      .join(',');
  }
  private async hashPassword(password: string) {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `${salt.toString('hex')}:${derived.toString('hex')}`;
  }
}
