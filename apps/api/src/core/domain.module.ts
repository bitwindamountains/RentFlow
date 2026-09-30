import { Global, Module } from '@nestjs/common';
import { DomainStore } from './domain.store.js';
import { DOMAIN_SERVICE } from './domain-service.js';
import { PrismaDomainService } from './prisma-domain.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [
    DomainStore,
    PrismaService,
    PrismaDomainService,
    {
      provide: DOMAIN_SERVICE,
      inject: [DomainStore, PrismaDomainService],
      useFactory: (memory: DomainStore, prisma: PrismaDomainService) =>
        process.env['DATABASE_URL'] &&
        process.env['USE_IN_MEMORY_STORE'] !== 'true'
          ? prisma
          : memory,
    },
  ],
  exports: [DOMAIN_SERVICE, PrismaService],
})
export class DomainModule {}
