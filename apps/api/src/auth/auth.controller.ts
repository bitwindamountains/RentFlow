import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { PASSWORD_MAX_LENGTH } from '../common/crypto.js';
import { environment, sessionCookieName } from '../config/environment.js';
import { AuthService, type IssuedSession } from './auth.service.js';
import { ANY_MEMBER, Auth, Public, RateLimit, Roles } from './decorators.js';
import type { SessionContext } from './session.types.js';

class RegisterDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(12) @MaxLength(PASSWORD_MAX_LENGTH) password!: string;
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsString() @MinLength(2) @MaxLength(120) organizationName!: string;
}
class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX_LENGTH) password!: string;
  @IsOptional() @IsString() @MaxLength(160) workspace?: string;
}
class EmailDto {
  @IsEmail() @MaxLength(254) email!: string;
}
class TokenDto {
  @IsString() @MinLength(20) @MaxLength(100) token!: string;
}
class ResetPasswordDto extends TokenDto {
  @IsString() @MinLength(12) @MaxLength(PASSWORD_MAX_LENGTH) password!: string;
}
class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX_LENGTH) currentPassword!: string;
  @IsString() @MinLength(12) @MaxLength(PASSWORD_MAX_LENGTH) newPassword!: string;
}
class MfaLoginDto {
  @IsString() @MinLength(20) @MaxLength(100) challenge!: string;
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
  @IsOptional() @IsString() @MaxLength(160) workspace?: string;
}
class PasswordDto {
  @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX_LENGTH) password!: string;
}
class MfaCodeDto {
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
}
class MfaChangeDto extends PasswordDto {
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
}
class SwitchWorkspaceDto {
  @IsString() @MinLength(1) @MaxLength(160) workspace!: string;
}

type CookieReply = FastifyReply & {
  setCookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
};

@ApiTags('authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit(5, '1 hour')
  @Post('register')
  async register(
    @Body() input: RegisterDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    return this.startSession(reply, await this.auth.register({ ...input, userAgent }));
  }

  @Public()
  @RateLimit(10, '15 minutes')
  @HttpCode(200)
  @Post('login')
  async login(
    @Body() input: LoginDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    const result = await this.auth.login({ ...input, userAgent });
    // With two-step sign-in on, no session exists until the code is checked.
    if ('mfaRequired' in result) return result;
    return this.startSession(reply, result);
  }

  @Public()
  @RateLimit(10, '15 minutes')
  @HttpCode(200)
  @Post('login/mfa')
  async loginMfa(
    @Body() input: MfaLoginDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    return this.startSession(reply, await this.auth.completeMfaLogin({ ...input, userAgent }));
  }

  @Roles(...ANY_MEMBER)
  @RateLimit(10, '15 minutes')
  @HttpCode(200)
  @Post('mfa/setup')
  mfaSetup(@Auth() session: SessionContext, @Body() input: PasswordDto) {
    return this.auth.startMfaSetup(session, input.password);
  }

  @Roles(...ANY_MEMBER)
  @RateLimit(10, '15 minutes')
  @HttpCode(200)
  @Post('mfa/enable')
  mfaEnable(@Auth() session: SessionContext, @Body() input: MfaCodeDto) {
    return this.auth.enableMfa(session, input.code);
  }

  @Roles(...ANY_MEMBER)
  @RateLimit(10, '15 minutes')
  @HttpCode(204)
  @Post('mfa/disable')
  async mfaDisable(@Auth() session: SessionContext, @Body() input: MfaChangeDto) {
    await this.auth.disableMfa(session, input.password, input.code);
  }

  @Roles(...ANY_MEMBER)
  @RateLimit(10, '15 minutes')
  @HttpCode(200)
  @Post('mfa/recovery-codes')
  mfaRecoveryCodes(@Auth() session: SessionContext, @Body() input: MfaChangeDto) {
    return this.auth.regenerateRecoveryCodes(session, input.password, input.code);
  }

  @Roles(...ANY_MEMBER)
  @Get('me')
  me(@Auth() session: SessionContext) {
    return this.auth.profile(session);
  }

  @Roles(...ANY_MEMBER)
  @HttpCode(204)
  @Post('logout')
  async logout(@Auth() session: SessionContext, @Res({ passthrough: true }) reply: CookieReply) {
    await this.auth.logout(session.sessionId);
    reply.clearCookie(sessionCookieName(), this.cookieOptions());
  }

  @Roles(...ANY_MEMBER)
  @HttpCode(200)
  @Post('switch-workspace')
  async switchWorkspace(
    @Auth() session: SessionContext,
    @Body() input: SwitchWorkspaceDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    return this.startSession(reply, await this.auth.switchWorkspace(session, input.workspace, userAgent));
  }

  @Public()
  @RateLimit(5, '15 minutes')
  @HttpCode(202)
  @Post('password/forgot')
  async forgotPassword(@Body() input: EmailDto) {
    await this.auth.requestPasswordReset(input.email);
    return { accepted: true };
  }

  @Public()
  @RateLimit(10, '15 minutes')
  @HttpCode(200)
  @Post('password/reset')
  async resetPassword(@Body() input: ResetPasswordDto) {
    await this.auth.resetPassword(input.token, input.password);
    return { reset: true };
  }

  @Public()
  @RateLimit(20, '15 minutes')
  @HttpCode(200)
  @Post('email/verify')
  async verifyEmail(@Body() input: TokenDto) {
    await this.auth.verifyEmail(input.token);
    return { verified: true };
  }

  @Roles(...ANY_MEMBER)
  @RateLimit(3, '15 minutes')
  @HttpCode(202)
  @Post('email/resend')
  async resendVerification(@Auth() session: SessionContext) {
    await this.auth.resendVerification(session);
    return { accepted: true };
  }

  @Roles(...ANY_MEMBER)
  @RateLimit(10, '15 minutes')
  @HttpCode(204)
  @Post('password')
  async changePassword(@Auth() session: SessionContext, @Body() input: ChangePasswordDto) {
    await this.auth.changePassword(session, input.currentPassword, input.newPassword);
  }

  @Roles(...ANY_MEMBER)
  @Get('sessions')
  sessions(@Auth() session: SessionContext) {
    return this.auth.listSessions(session);
  }

  @Roles(...ANY_MEMBER)
  @HttpCode(200)
  @Post('sessions/revoke-others')
  async revokeOthers(@Auth() session: SessionContext) {
    return { revoked: await this.auth.revokeOtherSessions(session) };
  }

  @Roles(...ANY_MEMBER)
  @HttpCode(204)
  @Delete('sessions/:id')
  async revokeSession(@Auth() session: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revokeSession(session, id);
  }

  private async startSession(reply: CookieReply, issued: IssuedSession) {
    reply.setCookie(sessionCookieName(), issued.token, {
      ...this.cookieOptions(),
      maxAge: environment().SESSION_ABSOLUTE_HOURS * 3600,
    });
    return this.auth.profile(issued.context);
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: environment().NODE_ENV === 'production',
      path: '/',
    };
  }
}
