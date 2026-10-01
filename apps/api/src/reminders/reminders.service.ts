import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ReminderKind } from '@prisma/client';
import { audit } from '../common/audit.js';
import { addDays, daysBetween, formatDateOnly, parseDateOnly } from '../common/dates.js';
import { formatMoney, sumMoney } from '../common/money.js';
import { PrismaService } from '../common/prisma.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { DEFAULT_RULES, dueStep, expiryStep, overdueStep, type ReminderRules } from './schedule.js';

const MAX_ATTEMPTS = 3;

interface LeaseContext {
  id: string;
  gracePeriodDays: number;
  endDate: Date | null;
  tenantId: string;
  tenantFirstName: string;
  tenantLastName: string;
  tenantEmail: string | null;
  tenantArchived: boolean;
  unitNumber: string;
  propertyName: string;
}

interface Organization {
  id: string;
  name: string;
  currency: string;
}

export interface ReminderRunResult {
  sent: number;
  failed: number;
}

/**
 * Automatic reminders: rent emails to tenants and lease-expiry emails to
 * owners and managers. Each (lease, kind, date, step) is claimed in
 * `ReminderDelivery` before sending, so concurrent runs and retries send it at
 * most once; a failed send is retried on later runs up to MAX_ATTEMPTS.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  // ------------------------------------------------------------------ settings
  async rules(organizationId: string): Promise<ReminderRules> {
    const row = await this.prisma.reminderSettings.findUnique({ where: { organizationId } });
    if (!row) return { ...DEFAULT_RULES };
    return {
      tenantReminders: row.tenantReminders,
      daysBeforeDue: row.daysBeforeDue,
      onDueDate: row.onDueDate,
      overdueDays: [...row.overdueDays].sort((a, b) => a - b),
      staffLeaseAlerts: row.staffLeaseAlerts,
      leaseExpiryDays: [...row.leaseExpiryDays].sort((a, b) => b - a),
    };
  }

  /** Applies the given fields on top of the current rules. */
  async updateRules(organizationId: string, actorUserId: string, input: Partial<ReminderRules>): Promise<ReminderRules> {
    const before = await this.rules(organizationId);
    // Validated DTOs carry every declared field, so absent ones arrive as undefined.
    const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    const merged: ReminderRules = { ...before, ...given };
    const data = {
      ...merged,
      overdueDays: [...new Set(merged.overdueDays)],
      leaseExpiryDays: [...new Set(merged.leaseExpiryDays)],
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.reminderSettings.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
      await audit(tx, {
        organizationId,
        actorUserId,
        action: 'REMINDER_SETTINGS_UPDATED',
        entityType: 'Organization',
        entityId: organizationId,
        before,
        after: data,
      });
    });
    return this.rules(organizationId);
  }

  async deliveries(organizationId: string, limit = 50) {
    const rows = await this.prisma.reminderDelivery.findMany({
      where: { organizationId, status: { not: 'SENDING' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        lease: {
          select: {
            primaryTenant: { select: { id: true, firstName: true, lastName: true } },
            rentableSpace: { select: { unit: { select: { number: true } } } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      subjectDate: formatDateOnly(row.subjectDate),
      step: row.step,
      recipients: row.recipients,
      amount: row.amount ? formatMoney(row.amount) : null,
      tenantId: row.lease.primaryTenant.id,
      tenantName: `${row.lease.primaryTenant.firstName} ${row.lease.primaryTenant.lastName}`,
      unitNumber: row.lease.rentableSpace.unit.number,
      sentAt: row.updatedAt.toISOString(),
    }));
  }

  // ------------------------------------------------------------------- sending
  async run(organizationId: string, today: string): Promise<ReminderRunResult> {
    const rules = await this.rules(organizationId);
    const result: ReminderRunResult = { sent: 0, failed: 0 };
    if (!rules.tenantReminders && !rules.staffLeaseAlerts) return result;
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { id: true, name: true, currency: true },
    });
    if (rules.tenantReminders) await this.rentReminders(organization, rules, today, result);
    if (rules.staffLeaseAlerts) await this.expiryAlerts(organization, rules, today, result);
    if (result.sent || result.failed)
      this.logger.log({ event: 'REMINDERS_SENT', organizationId, sent: result.sent, failed: result.failed });
    return result;
  }

  private async rentReminders(org: Organization, rules: ReminderRules, today: string, result: ReminderRunResult) {
    // Open balance per lease and due date, for active leases, up to the furthest "due soon" date.
    const rows = await this.prisma.$queryRaw<Array<{ leaseId: string; dueDate: Date; outstanding: Prisma.Decimal }>>`
      SELECT c."leaseId", c."dueDate", SUM(
               c.amount
               - COALESCE((SELECT SUM(pa.amount) FROM "PaymentAllocation" pa JOIN "Payment" p ON p.id = pa."paymentId" AND p.status = 'POSTED' WHERE pa."chargeId" = c.id), 0)
               - COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0)
             ) AS outstanding
      FROM "Charge" c JOIN "Lease" l ON l.id = c."leaseId"
      WHERE c."organizationId" = ${org.id}::uuid AND c.status = 'POSTED' AND l.status = 'ACTIVE'
        AND c."dueDate" <= ${addDays(today, rules.daysBeforeDue)}::date
      GROUP BY c."leaseId", c."dueDate"
      HAVING SUM(
               c.amount
               - COALESCE((SELECT SUM(pa.amount) FROM "PaymentAllocation" pa JOIN "Payment" p ON p.id = pa."paymentId" AND p.status = 'POSTED' WHERE pa."chargeId" = c.id), 0)
               - COALESCE((SELECT SUM(a.amount) FROM "ChargeAdjustment" a WHERE a."chargeId" = c.id), 0)
             ) > 0`;
    if (!rows.length) return;
    const byLease = new Map<string, Array<{ dueDate: string; outstanding: Prisma.Decimal }>>();
    for (const row of rows) {
      const list = byLease.get(row.leaseId) ?? [];
      list.push({ dueDate: formatDateOnly(row.dueDate), outstanding: row.outstanding });
      byLease.set(row.leaseId, list);
    }
    const leases = await this.leases(org.id, [...byLease.keys()]);
    // A tenant who has told staff they paid is not chased while that report is pending.
    const pending = new Set(
      (
        await this.prisma.paymentNotice.findMany({
          where: { organizationId: org.id, status: 'SUBMITTED', leaseId: { in: [...byLease.keys()] } },
          select: { leaseId: true },
        })
      ).map((notice) => notice.leaseId),
    );
    const portal = new Set(
      (
        await this.prisma.membership.findMany({
          where: {
            organizationId: org.id,
            role: 'TENANT',
            status: 'ACTIVE',
            tenantId: { in: leases.map((lease) => lease.tenantId) },
          },
          select: { tenantId: true },
        })
      ).map((membership) => membership.tenantId),
    );

    for (const lease of leases) {
      if (!lease.tenantEmail || lease.tenantArchived || pending.has(lease.id)) continue;
      const open = (byLease.get(lease.id) ?? []).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const balance = sumMoney(open.map((row) => row.outstanding));
      const overdue = open.filter((row) => addDays(row.dueDate, lease.gracePeriodDays) < today);
      const message = { org, lease, balance, portalLink: portal.has(lease.tenantId) ? this.mailer.link('/portal', {}) : null };

      if (overdue.length) {
        const oldest = overdue[0]!.dueDate;
        const step = overdueStep(rules, oldest, lease.gracePeriodDays, today);
        const amount = sumMoney(overdue.map((row) => row.outstanding));
        if (step !== null)
          await this.deliver(
            { organizationId: org.id, leaseId: lease.id, kind: 'RENT_OVERDUE', subjectDate: oldest, step, amount },
            () => [{ to: lease.tenantEmail!, ...rentEmail({ ...message, kind: 'RENT_OVERDUE', amount, date: oldest }) }],
            result,
          );
      }
      for (const row of open) {
        const due = dueStep(rules, row.dueDate, today);
        if (!due) continue;
        await this.deliver(
          { organizationId: org.id, leaseId: lease.id, kind: due.kind, subjectDate: row.dueDate, step: due.step, amount: row.outstanding },
          () => [{ to: lease.tenantEmail!, ...rentEmail({ ...message, kind: due.kind, amount: row.outstanding, date: row.dueDate }) }],
          result,
        );
      }
    }
  }

  private async expiryAlerts(org: Organization, rules: ReminderRules, today: string, result: ReminderRunResult) {
    const furthest = Math.max(0, ...rules.leaseExpiryDays);
    const ending = await this.prisma.lease.findMany({
      where: {
        organizationId: org.id,
        status: 'ACTIVE',
        endDate: { gte: parseDateOnly(today), lte: parseDateOnly(addDays(today, furthest)) },
      },
      select: { id: true },
    });
    if (!ending.length) return;
    const staff = await this.prisma.membership.findMany({
      where: {
        organizationId: org.id,
        role: { in: ['OWNER', 'MANAGER'] },
        status: 'ACTIVE',
        user: { disabledAt: null, emailVerifiedAt: { not: null } },
      },
      select: { user: { select: { email: true } } },
    });
    const recipients = [...new Set(staff.map((member) => member.user.email))];
    for (const lease of await this.leases(org.id, ending.map((row) => row.id))) {
      const endDate = formatDateOnly(lease.endDate!);
      const days = expiryStep(rules, endDate, today);
      if (days === null) continue;
      await this.deliver(
        { organizationId: org.id, leaseId: lease.id, kind: 'LEASE_EXPIRING', subjectDate: endDate, step: -days },
        () => recipients.map((to) => ({ to, ...expiryEmail(org, lease, endDate, today, this.mailer.link('/leases', {})) })),
        result,
      );
    }
  }

  /** Claims the delivery, sends it, and records the outcome. Returns without sending if already handled. */
  private async deliver(
    key: { organizationId: string; leaseId: string; kind: ReminderKind; subjectDate: string; step: number; amount?: Prisma.Decimal },
    messages: () => Array<{ to: string; subject: string; text: string }>,
    result: ReminderRunResult,
  ) {
    const id = await this.claim(key);
    if (!id) return;
    const batch = messages();
    if (!batch.length) {
      await this.prisma.reminderDelivery.update({ where: { id }, data: { status: 'SKIPPED' } });
      return;
    }
    let delivered = 0;
    for (const message of batch) {
      try {
        await this.mailer.send(message);
        delivered += 1;
      } catch (error) {
        this.logger.error({ event: 'REMINDER_DELIVERY_FAILED', kind: key.kind, type: (error as Error)?.name });
      }
    }
    // Partial delivery to staff counts as sent: retrying would duplicate the emails that did go out.
    const status = delivered ? 'SENT' : 'FAILED';
    await this.prisma.reminderDelivery.update({ where: { id }, data: { status, recipients: delivered } });
    if (delivered) result.sent += 1;
    else result.failed += 1;
  }

  private async claim(key: { organizationId: string; leaseId: string; kind: ReminderKind; subjectDate: string; step: number; amount?: Prisma.Decimal }) {
    const unique = { leaseId: key.leaseId, kind: key.kind, subjectDate: parseDateOnly(key.subjectDate), step: key.step };
    const { count } = await this.prisma.reminderDelivery.createMany({
      data: [{ ...unique, organizationId: key.organizationId, amount: key.amount ?? null }],
      skipDuplicates: true,
    });
    if (!count) {
      const retried = await this.prisma.reminderDelivery.updateMany({
        where: { ...unique, status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } },
        data: { status: 'SENDING', attempts: { increment: 1 } },
      });
      if (!retried.count) return null;
    }
    const row = await this.prisma.reminderDelivery.findUniqueOrThrow({
      where: { leaseId_kind_subjectDate_step: unique },
      select: { id: true },
    });
    return row.id;
  }

  private async leases(organizationId: string, ids: string[]): Promise<LeaseContext[]> {
    const leases = await this.prisma.lease.findMany({
      where: { organizationId, id: { in: ids } },
      select: {
        id: true,
        gracePeriodDays: true,
        endDate: true,
        primaryTenant: { select: { id: true, firstName: true, lastName: true, email: true, status: true } },
        rentableSpace: { select: { unit: { select: { number: true, property: { select: { name: true } } } } } },
      },
    });
    return leases.map((lease) => ({
      id: lease.id,
      gracePeriodDays: lease.gracePeriodDays,
      endDate: lease.endDate,
      tenantId: lease.primaryTenant.id,
      tenantFirstName: lease.primaryTenant.firstName,
      tenantLastName: lease.primaryTenant.lastName,
      tenantEmail: lease.primaryTenant.email,
      tenantArchived: lease.primaryTenant.status === 'ARCHIVED',
      unitNumber: lease.rentableSpace.unit.number,
      propertyName: lease.rentableSpace.unit.property.name,
    }));
  }
}

// --------------------------------------------------------------------- emails
function money(value: Prisma.Decimal, currency: string): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(Number(formatMoney(value)));
}

function longDate(date: string): string {
  return new Intl.DateTimeFormat('en-PH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    parseDateOnly(date),
  );
}

function rentEmail(input: {
  org: Organization;
  lease: LeaseContext;
  kind: 'RENT_DUE_SOON' | 'RENT_DUE_TODAY' | 'RENT_OVERDUE';
  amount: Prisma.Decimal;
  date: string;
  balance: Prisma.Decimal;
  portalLink: string | null;
}) {
  const { org, lease } = input;
  const amount = money(input.amount, org.currency);
  const place = `Unit ${lease.unitNumber}, ${lease.propertyName}`;
  const lines: string[] = [`Hi ${lease.tenantFirstName},`, ''];
  let subject: string;
  switch (input.kind) {
    case 'RENT_DUE_SOON':
      subject = `Reminder: ${amount} due ${longDate(input.date)}`;
      lines.push(`This is a reminder from ${org.name} that ${amount} is due on ${longDate(input.date)} for ${place}.`);
      break;
    case 'RENT_DUE_TODAY':
      subject = `Due today: ${amount}`;
      lines.push(`${amount} for ${place} is due today, ${longDate(input.date)}.`);
      break;
    case 'RENT_OVERDUE':
      subject = `Overdue: ${amount} for ${place}`;
      lines.push(
        `Your balance of ${amount} with ${org.name} for ${place} is overdue. The oldest unpaid amount was due on ${longDate(input.date)}.`,
        '',
        `Please pay as soon as you can, or contact ${org.name} if you think this is wrong.`,
      );
      break;
  }
  if (input.balance.greaterThan(input.amount))
    lines.push('', `Your total balance is ${money(input.balance, org.currency)}.`);
  lines.push(
    '',
    input.portalLink
      ? `See the details, or let them know you've paid, in your tenant portal:\n${input.portalLink}`
      : `If you've already paid, you can ignore this message.`,
    '',
    `This is an automatic reminder sent for ${org.name}.`,
  );
  return { subject, text: lines.join('\n') };
}

function expiryEmail(org: Organization, lease: LeaseContext, endDate: string, today: string, leasesLink: string) {
  const name = `${lease.tenantFirstName} ${lease.tenantLastName}`;
  const remaining = daysBetween(today, endDate);
  return {
    subject: `Lease ending ${longDate(endDate)}: ${name}, Unit ${lease.unitNumber}`,
    text: [
      `${name}'s lease for Unit ${lease.unitNumber}, ${lease.propertyName} ends on ${longDate(endDate)}, in ${remaining} ${remaining === 1 ? 'day' : 'days'}.`,
      '',
      'Renew the lease or plan the move-out in RentFlow:',
      leasesLink,
      '',
      `Automatic alert for ${org.name}. Owners and managers can change these alerts on the Reminders page.`,
    ].join('\n'),
  };
}
