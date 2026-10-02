import { Injectable, Logger } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';
import { formatDateOnly } from '../common/dates.js';
import { formatMoney } from '../common/money.js';
import { PrismaService, type Tx } from '../common/prisma.service.js';
import { MailerService, type MailMessage } from '../mail/mailer.service.js';

export type StaffAlertTopic = 'tenant.payment_reported' | 'tenant.repair_reported';

const MAX_ATTEMPTS = 5;
/** How long a claimed event is reserved before another run may pick it up again (crash recovery). */
const CLAIM_MINUTES = 10;

/**
 * Records a staff alert in the caller's transaction. The alert exists only if
 * the business write commits, and is sent once by `processPending`.
 * Payloads hold ids only; names and amounts are read at send time.
 */
export async function enqueueStaffAlert(
  tx: Tx,
  event: { organizationId: string; topic: StaffAlertTopic; aggregateType: string; aggregateId: string },
): Promise<void> {
  await tx.outboxEvent.create({ data: { ...event, payload: {} } });
}

const recipientsByTopic: Record<StaffAlertTopic, MembershipRole[]> = {
  'tenant.payment_reported': ['OWNER', 'MANAGER', 'COLLECTOR'],
  'tenant.repair_reported': ['OWNER', 'MANAGER', 'MAINTENANCE'],
};

/** Emails staff about things tenants did in the portal, via the transactional outbox. */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  /** Starts processing without delaying the HTTP response; the background job is the fallback. */
  kick(): void {
    this.processPending().catch((error: unknown) =>
      this.logger.error({ event: 'OUTBOX_RUN_FAILED', type: (error as Error)?.name }),
    );
  }

  /** Claims due events (skipping ones another run holds), sends them, and records the outcome. */
  async processPending(limit = 25): Promise<{ processed: number; failed: number }> {
    const claimed = await this.prisma.$queryRaw<Array<{ id: string; organizationId: string; topic: string; aggregateId: string; attempts: number }>>`
      UPDATE "OutboxEvent" SET status = 'PROCESSING', attempts = attempts + 1,
             "availableAt" = now() + make_interval(mins => ${CLAIM_MINUTES}::int)
      WHERE id IN (
        SELECT id FROM "OutboxEvent"
        WHERE status IN ('PENDING', 'PROCESSING') AND "availableAt" <= now()
        ORDER BY "availableAt" LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "organizationId", topic, "aggregateId", attempts`;
    let processed = 0;
    let failed = 0;
    for (const event of claimed) {
      let error: string | null = null;
      try {
        const messages = await this.messages(event.organizationId, event.topic as StaffAlertTopic, event.aggregateId);
        let delivered = 0;
        for (const message of messages) {
          try {
            await this.mailer.send(message);
            delivered += 1;
          } catch (sendError) {
            error = (sendError as Error)?.name ?? 'Error';
          }
        }
        // Some recipients got it: retrying would duplicate their copies.
        if (delivered || !messages.length) error = null;
      } catch (buildError) {
        error = (buildError as Error)?.name ?? 'Error';
      }
      if (!error) {
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'PROCESSED', processedAt: new Date(), lastError: null },
        });
        processed += 1;
        continue;
      }
      failed += 1;
      const giveUp = event.attempts >= MAX_ATTEMPTS;
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: giveUp ? 'FAILED' : 'PENDING',
          lastError: error.slice(0, 200),
          availableAt: new Date(Date.now() + 2 ** event.attempts * 60_000),
        },
      });
      this.logger.error({ event: 'STAFF_ALERT_FAILED', topic: event.topic, attempts: event.attempts, gaveUp: giveUp });
    }
    return { processed, failed };
  }

  private async recipients(organizationId: string, roles: MembershipRole[]): Promise<string[]> {
    const members = await this.prisma.membership.findMany({
      where: { organizationId, role: { in: roles }, status: 'ACTIVE', user: { disabledAt: null, emailVerifiedAt: { not: null } } },
      select: { user: { select: { email: true } } },
    });
    return [...new Set(members.map((member) => member.user.email))];
  }

  private async messages(organizationId: string, topic: StaffAlertTopic, aggregateId: string): Promise<MailMessage[]> {
    const to = await this.recipients(organizationId, recipientsByTopic[topic] ?? []);
    if (!to.length) return [];
    const content = topic === 'tenant.payment_reported' ? await this.paymentReported(organizationId, aggregateId) : await this.repairReported(organizationId, aggregateId);
    // The record may be gone (e.g. withdrawn and cleaned up); nothing to say then.
    if (!content) return [];
    return to.map((address) => ({ to: address, ...content }));
  }

  private async paymentReported(organizationId: string, noticeId: string) {
    const notice = await this.prisma.paymentNotice.findFirst({
      where: { id: noticeId, organizationId },
      include: {
        tenant: { select: { firstName: true, lastName: true } },
        lease: { select: { rentableSpace: { select: { unit: { select: { number: true } } } } } },
        organization: { select: { name: true, currency: true } },
      },
    });
    if (!notice || notice.status !== 'SUBMITTED') return null;
    const name = `${notice.tenant.firstName} ${notice.tenant.lastName}`;
    const amount = new Intl.NumberFormat('en-PH', { style: 'currency', currency: notice.organization.currency }).format(Number(formatMoney(notice.amount)));
    const method = notice.method.replace('_', ' ').toLowerCase();
    return {
      subject: `${name} reported a payment of ${amount}`,
      text: [
        `${name} (Unit ${notice.lease.rentableSpace.unit.number}) says they paid ${amount} by ${method} on ${formatDateOnly(notice.paidOn)}${notice.referenceNumber ? `, reference ${notice.referenceNumber}` : ''}.`,
        '',
        'Nothing is recorded until someone confirms it. Check that the money arrived, then confirm or reject it on the Payments page:',
        this.mailer.link('/payments', {}),
        '',
        `Automatic alert for ${notice.organization.name}.`,
      ].join('\n'),
    };
  }

  private async repairReported(organizationId: string, requestId: string) {
    const request = await this.prisma.maintenanceRequest.findFirst({
      where: { id: requestId, organizationId },
      include: {
        tenant: { select: { firstName: true, lastName: true } },
        unit: { select: { number: true } },
        property: { select: { name: true } },
        organization: { select: { name: true } },
      },
    });
    if (!request) return null;
    const name = request.tenant ? `${request.tenant.firstName} ${request.tenant.lastName}` : 'A tenant';
    const where = request.unit ? `Unit ${request.unit.number}, ${request.property.name}` : request.property.name;
    return {
      subject: `${request.priority === 'URGENT' ? 'Urgent repair' : 'Repair request'}: ${request.title}`,
      text: [
        `${name} reported a repair at ${where} (${request.priority.toLowerCase()} priority):`,
        '',
        request.title,
        request.description,
        '',
        'Assign or update it on the Maintenance page:',
        this.mailer.link('/maintenance', {}),
        '',
        `Automatic alert for ${request.organization.name}.`,
      ].join('\n'),
    };
  }
}
