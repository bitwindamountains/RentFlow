import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { todayInZone } from '../common/dates.js';
import { PrismaService } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';
import { BillingService } from '../billing/billing.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LeasesService } from '../rentals/leases.service.js';

const interval = 15 * 60 * 1000;
const leaseDuration = 10 * 60 * 1000;

/**
 * Periodic work: post due charges, expire ended leases, purge expired
 * security tokens. A lease row in `JobLock` guarantees one runner at a time,
 * so every API instance can safely enable jobs.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly leases: LeasesService,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!environment().ENABLE_JOBS) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    setTimeout(() => void this.tick(), 10_000).unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async tick(): Promise<{ organizations: number; charges: number; expired: number } | undefined> {
    if (!(await this.acquire('daily-operations'))) return undefined;
    let resolveRun!: () => void;
    this.running = new Promise((resolve) => (resolveRun = resolve));
    try {
      return await this.runAll();
    } catch (error) {
      this.logger.error({ event: 'JOB_FAILED', job: 'daily-operations', type: (error as Error)?.name });
      return undefined;
    } finally {
      await this.release('daily-operations');
      resolveRun();
    }
  }

  async runAll() {
    const organizations = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, timezone: true },
    });
    let charges = 0;
    let expired = 0;
    for (const organization of organizations) {
      try {
        const today = todayInZone(organization.timezone);
        expired += await this.leases.expireEnded(organization.id, today);
        charges += (await this.billing.runBilling(organization.id, null, today)).created;
      } catch (error) {
        // One organization's failure must not block billing for the others.
        this.logger.error({
          event: 'ORGANIZATION_JOB_FAILED',
          organizationId: organization.id,
          type: (error as Error)?.name,
        });
      }
    }
    // Staff alerts that could not be sent right away (provider down, crash) are retried here.
    await this.notifications.processPending();
    const now = new Date();
    await this.prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.prisma.userToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }, { revokedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }] },
    });
    await this.prisma.staffInvitation.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    if (charges || expired)
      this.logger.log({ event: 'JOB_COMPLETED', organizations: organizations.length, charges, expired });
    return { organizations: organizations.length, charges, expired };
  }

  private async acquire(name: string): Promise<boolean> {
    const until = new Date(Date.now() + leaseDuration);
    const rows = await this.prisma.$executeRaw`
      INSERT INTO "JobLock" (name, owner, "lockedUntil") VALUES (${name}, ${this.owner}, ${until})
      ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, "lockedUntil" = EXCLUDED."lockedUntil"
      WHERE "JobLock"."lockedUntil" < now() OR "JobLock".owner = EXCLUDED.owner`;
    return rows === 1;
  }

  private async release(name: string): Promise<void> {
    await this.prisma.jobLock.updateMany({
      where: { name, owner: this.owner },
      data: { lockedUntil: new Date(0) },
    });
  }
}
