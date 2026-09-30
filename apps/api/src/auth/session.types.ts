import type { MembershipRole } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

export interface SessionContext {
  /** Database id of the session row (never the bearer token). */
  sessionId: string;
  csrfToken: string;
  userId: string;
  organizationId: string;
  role: MembershipRole;
  expiresAt: Date;
  emailVerified: boolean;
}

export type AuthenticatedRequest = FastifyRequest & {
  auth: SessionContext;
  cookies: Record<string, string | undefined>;
};
