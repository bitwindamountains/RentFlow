import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../core/prisma.service.js';
import { OperationsService } from './operations.service.js';

@Injectable()
export class BillingJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingJobService.name);
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationsService,
  ) {}

  onModuleInit(): void {
    if (process.env['ENABLE_BILLING_JOBS'] !== 'true') return;
    void this.run();
    this.timer = setInterval(() => void this.run(), 60 * 60 * 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    try {
      const organizations = await this.prisma.organization.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          memberships: {
            where: { role: 'OWNER', status: 'ACTIVE' },
            select: { userId: true },
            take: 1,
          },
        },
      });
      for (const organization of organizations) {
        const actor = organization.memberships[0]?.userId;
        if (actor) await this.operations.runBilling(organization.id, actor);
      }
    } catch (error) {
      this.logger.error(
        'Automatic billing run failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
