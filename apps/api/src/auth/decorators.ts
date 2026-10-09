import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { MembershipRole } from '@prisma/client';
import type { AuthenticatedRequest, SessionContext } from './session.types.js';

export const IS_PUBLIC = 'rentflow:isPublic';
export const ROLES = 'rentflow:roles';
export const ALLOW_WITHOUT_MFA = 'rentflow:allowWithoutMfa';

/** Skips authentication (and therefore CSRF) for a route. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Account routes an owner can still use before turning on required two-step sign-in. */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);

/** Roles allowed to call a route; the handler-level list overrides the class-level list. */
export const Roles = (...roles: MembershipRole[]) => SetMetadata(ROLES, roles);

/** Every staff role. Tenants are deliberately excluded: they only reach /portal and their own account. */
export const ALL_ROLES: MembershipRole[] = ['OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER', 'MAINTENANCE'];
/** Signed-in people of any kind, for account endpoints (profile, password, sessions). */
export const ANY_MEMBER: MembershipRole[] = [...ALL_ROLES, 'TENANT'];
export const FINANCE_READERS: MembershipRole[] = ['OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER'];
export const MANAGERS: MembershipRole[] = ['OWNER', 'MANAGER'];
export const COLLECTORS: MembershipRole[] = ['OWNER', 'MANAGER', 'COLLECTOR'];

/** Overrides the default limit for this route, retaining the normalized client-IP key. */
export const RateLimit = (max: number, timeWindow: string) =>
  RouteConfig({
    rateLimit: {
      max: () => max * Number(process.env['RATE_LIMIT_MULTIPLIER'] ?? 1),
      timeWindow,
    },
  });

export const Auth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionContext =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);
