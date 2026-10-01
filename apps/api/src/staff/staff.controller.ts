import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Auth, Public, RateLimit, Roles } from '../auth/decorators.js';
import type { SessionContext } from '../auth/session.types.js';
import { PASSWORD_MAX_LENGTH } from '../common/crypto.js';
import { StaffService } from './staff.service.js';

class InvitationDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsEnum(MembershipRole) role!: MembershipRole;
}
class AcceptInvitationDto {
  @IsString() @MinLength(20) @MaxLength(100) token!: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX_LENGTH) password!: string;
}
class UpdateMemberDto {
  @IsOptional() @IsEnum(MembershipRole) role?: MembershipRole;
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
}

@ApiTags('staff')
@Roles('OWNER')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@Auth() auth: SessionContext) {
    return this.staff.list(auth.organizationId);
  }

  @RateLimit(20, '1 hour')
  @Post('invitations')
  invite(@Auth() auth: SessionContext, @Body() input: InvitationDto) {
    return this.staff.invite(auth.organizationId, auth.userId, input);
  }

  @Delete('invitations/:id')
  revokeInvitation(@Auth() auth: SessionContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.revokeInvitation(auth.organizationId, auth.userId, id);
  }

  @Patch(':membershipId')
  update(
    @Auth() auth: SessionContext,
    @Param('membershipId', ParseUUIDPipe) id: string,
    @Body() input: UpdateMemberDto,
  ) {
    return this.staff.updateMember(auth.organizationId, auth.userId, id, input);
  }

  @Delete(':membershipId')
  remove(@Auth() auth: SessionContext, @Param('membershipId', ParseUUIDPipe) id: string) {
    return this.staff.updateMember(auth.organizationId, auth.userId, id, { status: 'REVOKED' });
  }

  @Public()
  @RateLimit(10, '15 minutes')
  @Post('invitations/accept')
  accept(@Body() input: AcceptInvitationDto) {
    return this.staff.acceptInvitation(input);
  }
}
