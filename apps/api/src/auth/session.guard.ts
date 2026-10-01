import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MembershipRole } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { sessionCookieName } from '../config/environment.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC, ROLES } from './decorators.js';
import type { AuthenticatedRequest } from './session.types.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Global guard: authenticates the session cookie, enforces @Roles on the
 * server, and requires the session-bound CSRF token on state-changing calls.
 * Routes are closed by default; only @Public() routes skip it.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.auth.resolveSession(
      request.cookies?.[sessionCookieName()],
      request.headers['user-agent'],
    );
    if (!session) throw new UnauthorizedException('Authentication required');
    if (!safeMethods.has(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !sameSecret(csrf, session.csrfToken))
        throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Refresh the page and try again.' });
    }
    const roles = this.reflector.getAllAndOverride<MembershipRole[]>(ROLES, targets);
    if (!roles?.length || !roles.includes(session.role))
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Your role cannot perform this action.' });
    request.auth = session;
    return true;
  }
}
