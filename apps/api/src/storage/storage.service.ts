import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../common/errors.js';
import { PrismaService, type Tx } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';
import { FileStore } from './file-store.service.js';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly prisma: PrismaService, private readonly files: FileStore) {}

  async reserve(tx: Tx, organizationId: string, key: string, sizeBytes: number): Promise<void> {
    // Serialize reservations within a workspace, without holding a transaction during storage I/O.
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
    const used = await tx.storageObject.aggregate({
      where: { organizationId, state: { not: 'DELETED' } },
      _sum: { sizeBytes: true },
    });
    if ((used._sum.sizeBytes ?? 0) + sizeBytes > environment().STORAGE_QUOTA_BYTES)
      throw new DomainError('STORAGE_QUOTA_EXCEEDED', 413);
    await tx.storageObject.create({
      data: { key, organizationId, sizeBytes, availableAt: new Date(Date.now() + 60 * 60_000) },
    });
  }

  async finalize(tx: Tx, key: string): Promise<void> {
    const updated = await tx.storageObject.updateMany({
      where: { key, state: 'PENDING', availableAt: { gt: new Date() } },
      data: { state: 'READY' },
    });
    if (!updated.count) throw new DomainError('UPLOAD_EXPIRED', 409);
  }

  async remove(tx: Tx, key: string): Promise<void> {
    await tx.storageObject.update({ where: { key }, data: { state: 'DELETE_PENDING', availableAt: new Date() } });
  }

  /** Includes uploads abandoned before their document transaction committed. */
  async processPending(key?: string): Promise<void> {
    const rows = await this.prisma.storageObject.findMany({
      where: { key, state: { in: ['PENDING', 'DELETE_PENDING'] }, availableAt: { lte: new Date() } },
      orderBy: [{ availableAt: 'asc' }, { key: 'asc' }],
      take: 100,
    });
    for (const row of rows) {
      const attempt = row.attempts + 1;
      const claimed = await this.prisma.storageObject.updateMany({
        where: { key: row.key, state: row.state, attempts: row.attempts, availableAt: { lte: new Date() } },
        data: { state: 'DELETE_PENDING', attempts: attempt, availableAt: new Date(Date.now() + 5 * 60_000) },
      });
      if (!claimed.count) continue;
      try {
        await this.files.delete(row.key);
        await this.prisma.storageObject.updateMany({
          where: { key: row.key, state: 'DELETE_PENDING', attempts: attempt },
          data: { state: 'DELETED' },
        });
      } catch (error) {
        // Keep the reservation until the bytes have actually been removed.
        this.logger.error({ event: 'STORAGE_CLEANUP_FAILED', key: row.key, type: (error as Error)?.name });
      }
    }
  }
}
