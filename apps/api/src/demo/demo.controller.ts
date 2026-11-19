import { Controller, Get, Headers, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from '../auth/auth.service.js';
import { Public, RateLimit } from '../auth/decorators.js';
import { type CookieReply, startSessionReply } from '../auth/session-reply.js';
import { DemoService } from './demo.service.js';

@ApiTags('demo')
@Controller('demo')
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    private readonly auth: AuthService,
  ) {}

  /** Whether "Try the demo" is offered on this server. */
  @Public()
  @Get()
  status() {
    return { enabled: this.demo.enabled() };
  }

  /** Creates a private sample workspace (deleted after 24 hours) and signs in to it. */
  @Public()
  @RateLimit(3, '1 hour')
  @Post()
  async create(@Headers('user-agent') userAgent: string | undefined, @Res({ passthrough: true }) reply: CookieReply) {
    return startSessionReply(reply, this.auth, await this.demo.create(userAgent));
  }
}
