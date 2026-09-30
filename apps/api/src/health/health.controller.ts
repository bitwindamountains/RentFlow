import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../core/prisma.service.js';

@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @ApiOperation({ summary: 'Process liveness probe' })
  live() {
    return {
      status: 'ok',
      service: 'rentflow-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Service readiness probe' })
  async ready() {
    const usesDatabase =
      Boolean(process.env['DATABASE_URL']) &&
      process.env['USE_IN_MEMORY_STORE'] !== 'true';
    if (usesDatabase) await this.prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ready',
      checks: {
        configuration: 'ok',
        database: usesDatabase ? 'ok' : 'not-configured',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
