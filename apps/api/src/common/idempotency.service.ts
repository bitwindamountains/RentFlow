import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { sha256, stableStringify } from './crypto.js';
import { DomainError } from './errors.js';
import { isUniqueViolation, PrismaService, type Tx } from './prisma.service.js';

export function requireIdempotencyKey(key: string | undefined): string {
  if (!key || key.length < 8 || key.length > 100 || !/^[\w.:-]+$/.test(key))
    throw new DomainError('INVALID_IDEMPOTENCY_KEY');
  return key;
}

/**
 * Executes a financial command exactly once per (organization, key, operation).
 * The response is stored in the same serializable transaction as the writes,
 * so a retry after an uncertain network failure returns the original result.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async execute<T extends object>(
    scope: { organizationId: string; key: string; operation: string },
    input: unknown,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    const requestHash = sha256(stableStringify(input));
    const prior = await this.lookup(scope, requestHash);
    if (prior) return prior as T;
    try {
      return await this.prisma.serializable(async (tx) => {
        // Recheck inside each retry: a competing command may have committed
        // since the initial lookup, changing the balances work() validates.
        const replay = await this.lookup(scope, requestHash, tx);
        if (replay) return replay as T;
        const response = await work(tx);
        await tx.idempotencyKey.create({
          data: {
            ...scope,
            requestHash,
            responseCode: 201,
            responseBody: response as Prisma.InputJsonValue,
            // Financial retries must remain safe for the lifetime of the record.
            expiresAt: null,
          },
        });
        return response;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.lookup(scope, requestHash);
        if (replay) return replay as T;
      }
      throw error;
    }
  }

  private async lookup(
    scope: { organizationId: string; key: string; operation: string },
    requestHash: string,
    db: Tx | PrismaService = this.prisma,
  ) {
    const record = await db.idempotencyKey.findUnique({
      where: { organizationId_key_operation: scope },
    });
    if (!record) return undefined;
    if (record.requestHash !== requestHash)
      throw new DomainError('IDEMPOTENCY_CONFLICT', 422);
    return record.responseBody ?? undefined;
  }
}
