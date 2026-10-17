import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../src/billing/billing.service.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { MailerService } from '../src/mail/mailer.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { LeasesService } from '../src/rentals/leases.service.js';
import { StorageService } from '../src/storage/storage.service.js';
import { PrismaService } from '../src/common/prisma.service.js';
import { createRental, monthStart, prismaOf, registerOwner, startApp } from './helpers.js';

/** Background jobs against the real database: the JobLock row is the only thing keeping two API instances apart. */
describe('background job lock', () => {
  let app: NestFastifyApplication;
  /** A second API instance's job runner: same database, its own lock owner id. */
  const otherInstance = () =>
    new JobsService(app.get(PrismaService), app.get(BillingService), app.get(LeasesService), app.get(NotificationsService), app.get(StorageService), app.get(MailerService));
  const result = { organizations: 0, charges: 0, expired: 0 };

  beforeAll(async () => { app = await startApp(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await prismaOf(app).jobLock.deleteMany({});
  });
  afterAll(async () => app.close());

  it('lets only one instance run while the other holds the lock', async () => {
    const first = otherInstance();
    const second = otherInstance();
    let finish!: () => void;
    const holding = new Promise<void>((resolve) => { finish = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(first, 'runAll').mockImplementation(async () => { started(); await holding; return result; });
    const secondRun = vi.spyOn(second, 'runAll').mockResolvedValue(result);

    const firstTick = first.tick();
    await running;
    expect(await second.tick()).toBeUndefined();
    expect(secondRun).not.toHaveBeenCalled();
    finish();
    expect(await firstTick).toEqual(result);

    // Released at the end of the run, so the next tick anywhere may take it.
    expect(await second.tick()).toEqual(result);
  });

  it('takes over a lock whose holder stopped renewing it', async () => {
    await prismaOf(app).jobLock.create({ data: { name: 'daily-operations', owner: 'crashed-instance', lockedUntil: new Date(Date.now() - 1000) } });
    const runner = otherInstance();
    vi.spyOn(runner, 'runAll').mockResolvedValue(result);
    expect(await runner.tick()).toEqual(result);
  });

  it('stops working as soon as it learns another instance took the lock', async () => {
    const runner = otherInstance();
    let continuedAfterLoss = false;
    vi.spyOn(runner, 'runAll').mockImplementation(async (checkLease) => {
      await prismaOf(app).jobLock.update({ where: { name: 'daily-operations' }, data: { owner: 'another-instance' } });
      await checkLease!();
      continuedAfterLoss = true;
      return result;
    });
    expect(await runner.tick()).toBeUndefined();
    expect(continuedAfterLoss).toBe(false);
    // Its release does not free a lock it no longer owns.
    expect((await prismaOf(app).jobLock.findUniqueOrThrow({ where: { name: 'daily-operations' } })).owner).toBe('another-instance');
  });

  it('keeps billing other workspaces when one workspace fails', async () => {
    const broken = await registerOwner(app);
    const healthy = await registerOwner(app);
    const brokenRental = await createRental(broken.client, { startDate: monthStart(-2), firstMonth: 'NONE' });
    const healthyRental = await createRental(healthy.client, { startDate: monthStart(-2), firstMonth: 'NONE' });
    const brokenOrg = (await prismaOf(app).lease.findUniqueOrThrow({ where: { id: brokenRental.lease.id } })).organizationId;
    const billing = app.get(BillingService);
    const runBilling = billing.runBilling.bind(billing);
    vi.spyOn(billing, 'runBilling').mockImplementation(async (organizationId, ...rest) => {
      if (organizationId === brokenOrg) throw new Error('simulated failure');
      return runBilling(organizationId, ...rest);
    });

    await app.get(JobsService).runAll();
    expect(await prismaOf(app).charge.count({ where: { leaseId: healthyRental.lease.id } })).toBeGreaterThan(0);
    expect(await prismaOf(app).charge.count({ where: { leaseId: brokenRental.lease.id } })).toBe(0);
  });
});
