import { Global, Module } from '@nestjs/common';
import { MailerService } from '../mail/mailer.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, IdempotencyService, MailerService],
  exports: [PrismaService, IdempotencyService, MailerService],
})
export class CommonModule {}
