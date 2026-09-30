import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from './skip-throttle.js';
import { Public } from '../auth/decorators.js';
import { PrismaService } from '../common/prisma.service.js';

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
      await this.prisma.$queryRaw`SELECT 1 FROM "JobLock" LIMIT 1`;
    } catch {
      throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'Database unavailable' });
    }
    return { status: 'ready', timestamp: new Date().toISOString() };
  }
}
