import type { FastifyReply } from 'fastify';
import { environment, sessionCookieName } from '../config/environment.js';
import type { AuthService, IssuedSession } from './auth.service.js';

export type CookieReply = FastifyReply & {
  setCookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
};

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: environment().NODE_ENV === 'production',
    path: '/',
  };
}

/** Sets the session cookie for a new session and answers with the signed-in profile. */
export async function startSessionReply(reply: CookieReply, auth: AuthService, issued: IssuedSession) {
  reply.setCookie(sessionCookieName(), issued.token, {
    ...sessionCookieOptions(),
    maxAge: environment().SESSION_ABSOLUTE_HOURS * 3600,
  });
  return auth.profile(issued.context);
}
