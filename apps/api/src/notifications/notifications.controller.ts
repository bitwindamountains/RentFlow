import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Auth, MANAGERS, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { PrismaService } from '../common/prisma.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { notFound } from '../common/errors.js';

/** Operator visibility without exposing recipient addresses or message contents. */
@Roles(...MANAGERS)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService, private readonly mailer: MailerService) {}

  @Get('mail/failed')
  failedMail(@Auth() session: SessionContext) {
    return this.prisma.mailDelivery.findMany({
      where: { OR: [{ organizationId: session.organizationId }, { userId: session.userId }], status: 'FAILED' },
      select: { id: true, kind: true, attempts: true, lastError: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  @Post('mail/:id/retry')
  async retryMail(@Auth() session: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    const updated = await this.prisma.mailDelivery.updateMany({
      where: { id, OR: [{ organizationId: session.organizationId }, { userId: session.userId }], status: 'FAILED', encryptedBody: { not: null }, expiresAt: { gt: new Date() } },
      data: { status: 'PENDING', attempts: 0, availableAt: new Date(), lastError: null },
    });
    if (!updated.count) throw notFound('MAIL_NOT_RETRYABLE');
    this.mailer.kick();
    return { queued: true };
  }

  @Get('failed')
  failed(@Auth() session: SessionContext) {
    return this.prisma.outboxEvent.findMany({
      where: { organizationId: session.organizationId, status: 'FAILED' },
      select: { id: true, topic: true, aggregateType: true, aggregateId: true, attempts: true, lastError: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }
}
