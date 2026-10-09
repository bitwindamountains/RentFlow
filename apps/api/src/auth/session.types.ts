import type { MembershipRole } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

export interface SessionContext {
  /** Database id of the session row (never the bearer token). */
  sessionId: string;
  csrfToken: string;
  userId: string;
  organizationId: string;
  role: MembershipRole;
  /** The tenant record a TENANT session may see; null for staff. */
  tenantId: string | null;
  expiresAt: Date;
  emailVerified: boolean;
  /** An owner of a workspace that requires two-step sign-in, who has not turned it on yet. */
  mfaSetupRequired: boolean;
}

export type AuthenticatedRequest = FastifyRequest & {
  auth: SessionContext;
  cookies: Record<string, string | undefined>;
};
