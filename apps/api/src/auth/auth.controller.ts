import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { FastifyReply } from 'fastify';
import { DOMAIN_SERVICE, type DomainService } from '../core/domain-service.js';
import type { AuthenticatedRequest } from './session.guard.js';
import { Public } from './public.decorator.js';

class RegisterDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsString() @MinLength(2) @MaxLength(120) organizationName!: string;
}

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
  @IsOptional() @IsString() @MaxLength(160) workspace?: string;
}

type CookieReply = FastifyReply & {
  setCookie(
    name: string,
    value: string,
    options: Record<string, unknown>,
  ): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
};

@ApiTags('authentication')
@Controller('auth')
export class AuthController {
  constructor(@Inject(DOMAIN_SERVICE) private readonly store: DomainService) {}

  @Public()
  @Post('register')
  async register(
    @Body() input: RegisterDto,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    const result = (await this.store.register(input)) as {
      session: { sessionId: string };
    };
    this.setSessionCookie(reply, result.session.sessionId);
    return this.store.profile(result.session as never);
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() input: LoginDto,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    const result = (await this.store.login(
      input.email,
      input.password,
      input.workspace?.trim().toLowerCase(),
    )) as { session: { sessionId: string } } | undefined;
    if (!result) throw new UnauthorizedException('Invalid email or password');
    this.setSessionCookie(reply, result.session.sessionId);
    return this.store.profile(result.session as never);
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return this.store.profile(request.auth);
  }

  @HttpCode(204)
  @Post('logout')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    await this.store.logout(request.auth.sessionId);
    reply.clearCookie('rentflow_session', { path: '/' });
  }

  private setSessionCookie(reply: CookieReply, sessionId: string): void {
    reply.setCookie('rentflow_session', sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env['NODE_ENV'] === 'production',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
  }
}
