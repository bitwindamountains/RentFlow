import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { todayInZone } from '../common/dates.js';
import { PrismaService } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';
import { BillingService } from '../billing/billing.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LeasesService } from '../rentals/leases.service.js';
import { StorageService } from '../storage/storage.service.js';
import { MailerService } from '../mail/mailer.service.js';

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
  private startupTimer?: NodeJS.Timeout;
  private running?: Promise<{ organizations: number; charges: number; expired: number } | undefined>;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly leases: LeasesService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly mailer: MailerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!environment().ENABLE_JOBS) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    this.startupTimer = setTimeout(() => void this.tick(), 10_000);
    this.startupTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    await this.running;
  }

  async tick(): Promise<{ organizations: number; charges: number; expired: number } | undefined> {
    if (this.running || this.stopping) return undefined;
    this.running = this.executeTick();
    try { return await this.running; }
    finally { this.running = undefined; }
  }

  private async executeTick() {
    let acquired = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let renewing: Promise<void> | undefined;
    let lost = false;
    const renew = async () => {
      if (lost) throw new Error('Job lease lost');
      if (renewing) return renewing;
      renewing = this.renew('daily-operations');
      try { await renewing; }
      catch (error) { lost = true; throw error; }
      finally { renewing = undefined; }
    };
    try {
      acquired = await this.acquire('daily-operations');
      if (!acquired) return undefined;
      heartbeat = setInterval(() => { void renew().catch(() => { lost = true; }); }, leaseDuration / 3);
      heartbeat.unref();
      return await this.runAll(renew);
    } catch (error) {
      this.logger.error({ event: 'JOB_FAILED', job: 'daily-operations', type: (error as Error)?.name });
      return undefined;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await renewing?.catch(() => undefined);
      if (acquired) {
        try { await this.release('daily-operations'); }
        catch (error) { this.logger.error({ event: 'JOB_RELEASE_FAILED', type: (error as Error)?.name }); }
      }
    }
  }

  async runAll(checkLease: () => Promise<void> = async () => undefined) {
    const organizations = await this.prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, timezone: true },
    });
    let charges = 0;
    let expired = 0;
    for (const organization of organizations) {
      await checkLease();
      try {
        const today = todayInZone(organization.timezone);
        charges += (await this.billing.runBilling(organization.id, null, today)).created;
        await this.billing.applyExistingCredits(organization.id);
        expired += await this.leases.expireEnded(organization.id, today);
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
    await checkLease();
    await this.notifications.processPending();
    await checkLease();
    await this.storage.processPending();
    await checkLease();
    await this.mailer.processPending();
    const now = new Date();
    await this.prisma.userToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    await this.prisma.loginFailure.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 86_400_000) } } });
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
    const rows = await this.prisma.$executeRaw`
      INSERT INTO "JobLock" (name, owner, "lockedUntil") VALUES (${name}, ${this.owner}, now() + make_interval(secs => ${leaseDuration / 1000}::int))
      ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, "lockedUntil" = EXCLUDED."lockedUntil"
      WHERE "JobLock"."lockedUntil" < now()`;
    return rows === 1;
  }

  private async renew(name: string): Promise<void> {
    const rows = await this.prisma.$executeRaw`
      UPDATE "JobLock" SET "lockedUntil" = now() + make_interval(secs => ${leaseDuration / 1000}::int)
      WHERE name = ${name} AND owner = ${this.owner} AND "lockedUntil" > now()`;
    if (rows !== 1) throw new Error('Job lease lost');
  }

  private async release(name: string): Promise<void> {
    await this.prisma.jobLock.updateMany({
      where: { name, owner: this.owner },
      data: { lockedUntil: new Date(0) },
    });
  }
}
