import { Global, Module } from '@nestjs/common';
import { MailerService } from '../mail/mailer.service.js';
import { FileStore } from '../storage/file-store.service.js';
import { StorageService } from '../storage/storage.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, IdempotencyService, MailerService, FileStore, StorageService],
  exports: [PrismaService, IdempotencyService, MailerService, FileStore, StorageService],
})
export class CommonModule {}
