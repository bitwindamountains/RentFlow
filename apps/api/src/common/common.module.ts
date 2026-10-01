import { Global, Module } from '@nestjs/common';
import { MailerService } from '../mail/mailer.service.js';
import { FileStore } from '../storage/file-store.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, IdempotencyService, MailerService, FileStore],
  exports: [PrismaService, IdempotencyService, MailerService, FileStore],
})
export class CommonModule {}
