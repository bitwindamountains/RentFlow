import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { waitUntil } from '@vercel/functions';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MailerService } from './mail/mailer.service.js';
import { NotificationsService } from './notifications/notifications.service.js';

/**
 * Vercel Function entry (`api/index.mjs` at the repository root re-exports it). One Nest app per
 * warm instance; requests are handed to Fastify's own request listener, so the pipeline is the
 * same as `main.ts` and the e2e tests. Periodic jobs run through GET /jobs/run (Vercel Cron).
 */
let app: Promise<NestFastifyApplication> | undefined;

async function start(): Promise<NestFastifyApplication> {
  const { createApp } = await import('./bootstrap.js');
  const created = await createApp();
  await created.init();
  await created.getHttpAdapter().getInstance().ready();
  return created;
}

/** vercel.json rewrites /api/:path* to /api?__path=:path*; put the original path back. */
export function originalUrl(url: string): string {
  const parsed = new URL(url, 'http://vercel.internal');
  if (parsed.pathname !== '/api' || !parsed.searchParams.has('__path')) return url;
  const path = parsed.searchParams.get('__path') ?? '';
  parsed.searchParams.delete('__path');
  const query = parsed.searchParams.toString();
  return `/api/${path}${query ? `?${query}` : ''}`;
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!app) app = start().catch((error: unknown) => { app = undefined; throw error; });
  const ready = await app;
  request.url = originalUrl(request.url ?? '/');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) {
    // Queued email and staff alerts are sent after the response; keep the instance alive until they are.
    // If it is still cut short, the claim expires and the next cron run retries.
    waitUntil(new Promise((done) => response.once('close', done)).then(() =>
      Promise.allSettled([ready.get(MailerService).processPending(), ready.get(NotificationsService).processPending()]),
    ));
  }
  ready.getHttpAdapter().getInstance().server.emit('request', request, response);
}
