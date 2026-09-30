import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { SessionContext } from '../core/domain.store.js';
import { DOMAIN_SERVICE, type DomainService } from '../core/domain-service.js';
import { IS_PUBLIC } from './public.decorator.js';
import { ROLES } from './roles.decorator.js';
import type { MembershipRole } from '@prisma/client';

export type AuthenticatedRequest = FastifyRequest & {
  auth: SessionContext;
  cookies: Record<string, string | undefined>;
};

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DOMAIN_SERVICE) private readonly store: DomainService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = (await this.store.getSession(
      request.cookies?.['rentflow_session'],
    )) as SessionContext | undefined;
    if (!session) throw new UnauthorizedException('Authentication required');
    const requiredRoles = this.reflector.getAllAndOverride<MembershipRole[]>(
      ROLES,
      [context.getHandler(), context.getClass()],
    );
    if (
      requiredRoles &&
      !requiredRoles.includes(session.role as MembershipRole)
    )
      throw new ForbiddenException('Your role cannot perform this action');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf !== session.csrfToken)
        throw new UnauthorizedException('Invalid CSRF token');
    }
    request.auth = session;
    return true;
  }
}
