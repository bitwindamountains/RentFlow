import { SetMetadata } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';

export const ROLES = 'roles';
export const Roles = (...roles: MembershipRole[]) => SetMetadata(ROLES, roles);
