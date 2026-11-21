import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Wait for a pooled connection instead of failing with P2028 after Prisma's 2 s default:
    // a serverless instance with a small pool serves many requests at once.
    super({ transactionOptions: { maxWait: 10_000 } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs work in a SERIALIZABLE transaction, retrying on serialization
   * failures (P2034). The callback must be free of side effects outside the
   * transaction so that a retry is safe.
   */
  async serializable<T>(work: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15_000,
        });
      } catch (error) {
        if (!isSerializationFailure(error) || attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export function isSerializationFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  );
}
