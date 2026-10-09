import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from './skip-throttle.js';
import { Public } from '../auth/decorators.js';
import { PrismaService } from '../common/prisma.service.js';
import { environment } from '../config/environment.js';
import { readdirSync } from 'node:fs';

const requiredMigrations = readdirSync(new URL('../../prisma/migrations/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name);

@Public()
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @ApiOperation({ summary: 'Process liveness probe' })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe: database reachable and migrated' })
  async ready() {
    try {
      const applied = await this.prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const names = new Set(applied.map(row => row.migration_name));
      if (!requiredMigrations.length || requiredMigrations.some(name => !names.has(name))) throw new Error('Migrations pending');
    } catch {
      throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'Database unavailable' });
    }
    return { status: 'ready', timestamp: new Date().toISOString() };
  }
}

/** Public facts the signed-out privacy notice needs. */
@Public()
@ApiTags('health')
@Controller('privacy')
export class PrivacyController {
  @Get()
  @ApiOperation({ summary: 'Contact for personal-data requests, shown on the privacy notice' })
  contact() {
    return { contactEmail: environment().PRIVACY_CONTACT_EMAIL || null };
  }
}
