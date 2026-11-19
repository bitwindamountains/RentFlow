import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthService, uniqueSlug, type IssuedSession } from '../auth/auth.service.js';
import { BalancesService } from '../billing/balances.service.js';
import { BillingService } from '../billing/billing.service.js';
import { audit } from '../common/audit.js';
import { todayInZone } from '../common/dates.js';
import { DomainError } from '../common/errors.js';
import { PrismaService } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PropertiesService } from '../rentals/properties.service.js';
import { RentalSetupService } from '../rentals/setup.service.js';
import { WorkService } from '../work/work.service.js';
import { deleteDemoOrganization } from './demo-cleanup.js';
import { seedDemo } from './demo-seed.js';

const DEMO_LIFETIME_MS = 24 * 3_600_000;
/** Never matches a stored-hash format, so the demo owner can't sign in with a password. */
const UNUSABLE_PASSWORD_HASH = '!demo';

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);
  /**
   * Demos are created one at a time: parallel seeds run into each other's
   * serializable transactions, and the cap check stays exact. The API runs as a
   * single instance (docs/production-operations.md), so an in-process queue is enough.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly setup: RentalSetupService,
    private readonly properties: PropertiesService,
    private readonly billing: BillingService,
    private readonly balances: BalancesService,
    private readonly payments: PaymentsService,
    private readonly work: WorkService,
  ) {}

  enabled(): boolean {
    return environment().DEMO_ENABLED;
  }

  /** Creates a private, pre-filled demo workspace and signs its owner in. */
  create(userAgent?: string): Promise<IssuedSession> {
    const run = this.queue.then(() => this.createNow(userAgent));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async createNow(userAgent?: string): Promise<IssuedSession> {
    const env = environment();
    if (!env.DEMO_ENABLED) throw new DomainError('DEMO_UNAVAILABLE', 503);
    // Expired demos don't count (their sessions are already refused); the job deletes them.
    if ((await this.liveDemos()) >= env.DEMO_MAX_ACTIVE) throw new DomainError('DEMO_UNAVAILABLE', 503);

    const issued = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: `demo-${randomUUID()}@demo.rentflow.invalid`,
          displayName: 'Demo Owner',
          passwordHash: UNUSABLE_PASSWORD_HASH,
          emailVerifiedAt: new Date(),
        },
      });
      const organization = await tx.organization.create({
        data: {
          name: 'Demo Rentals',
          slug: await uniqueSlug(tx, `demo-${randomBytes(4).toString('hex')}`),
          receiptPrefix: 'DEMO',
          requireOwnerMfa: false,
          demoExpiresAt: new Date(Date.now() + DEMO_LIFETIME_MS),
          receiptSequence: { create: {} },
        },
      });
      await tx.membership.create({
        data: { userId: user.id, organizationId: organization.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
      });
      await audit(tx, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: 'DEMO_WORKSPACE_CREATED',
        entityType: 'Organization',
        entityId: organization.id,
      });
      return this.auth.issueSession(tx, user.id, organization.id, { role: 'OWNER', tenantId: null }, true, userAgent);
    });

    const { organizationId, userId } = issued.context;
    try {
      await seedDemo(
        { setup: this.setup, properties: this.properties, billing: this.billing, balances: this.balances, payments: this.payments, work: this.work },
        organizationId,
        userId,
        todayInZone('Asia/Manila'),
      );
    } catch (error) {
      this.logger.error({ event: 'DEMO_SEED_FAILED', type: (error as Error)?.name });
      await deleteDemoOrganization(this.prisma, organizationId).catch(() => undefined);
      throw error;
    }
    return issued;
  }

  private liveDemos(): Promise<number> {
    return this.prisma.organization.count({ where: { demoExpiresAt: { gt: new Date() } } });
  }
}
