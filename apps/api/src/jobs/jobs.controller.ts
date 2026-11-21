import { Controller, Get, Headers, NotFoundException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators.js';
import { sameSecret } from '../common/crypto.js';
import { environment } from '../config/environment.js';
import { SkipThrottle } from '../health/skip-throttle.js';
import { JobsService } from './jobs.service.js';

/**
 * Runs the periodic jobs once, for hosts without a long-running process (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`). Without a secret configured the route does not exist.
 */
@ApiExcludeController()
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Public()
  @SkipThrottle()
  @Get('run')
  async run(@Headers('authorization') authorization: string | undefined) {
    const secret = environment().CRON_SECRET;
    if (!secret || typeof authorization !== 'string' || !sameSecret(authorization, `Bearer ${secret}`))
      throw new NotFoundException();
    const result = await this.jobs.tick();
    // undefined: another runner holds the lock, or the run failed (logged as JOB_FAILED).
    return { ran: result !== undefined, ...result };
  }
}
