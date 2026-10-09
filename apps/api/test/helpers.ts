import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { PrismaService } from '../src/common/prisma.service.js';
import { addDays, dateOf, todayInZone } from '../src/common/dates.js';
import { resetEnvironmentCache } from '../src/config/environment.js';
import { MailerService } from '../src/mail/mailer.service.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export const api = (path: string) => `/api/v1${path}`;
export const today = () => todayInZone('Asia/Manila');
export const daysFromToday = (days: number) => addDays(today(), days);
/** First day of the month `offset` months from the current month. */
export const monthStart = (offset = 0) => {
  const now = today();
  return dateOf(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1 + offset, 1);
};
export const unique = () => randomUUID().slice(0, 8);

export async function startApp(): Promise<NestFastifyApplication> {
  process.env['DATABASE_URL'] = inject('databaseUrl');
  resetEnvironmentCache();
  const { createApp } = await import('../src/bootstrap.js');
  const app = await createApp({ logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export interface Result {
  status: number;
  body: any;
  text: string;
  raw: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}

const idempotentPaths = [/\/payments$/, /\/charges$/, /\/deposits$/, /\/rental-setup$/];

/** A browser-like client: keeps the session cookie and sends the CSRF token. */
export class Client {
  cookie = '';
  csrf = '';
  constructor(private readonly app: NestFastifyApplication) {}

  async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Result> {
    const url = path.startsWith('/api') ? path : api(path);
    const response = await this.app.inject({
      method,
      url,
      payload: payload as never,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}),
        ...(method === 'POST' && idempotentPaths.some((pattern) => pattern.test(url)) ? { 'idempotency-key': randomUUID() } : {}),
        ...headers,
      },
    });
    // Wait for the local log-mail worker so assertions observe completed delivery.
    await this.app.get(MailerService).processPending();
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      const first = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;
      this.cookie = first.endsWith('=') ? '' : first;
    }
    const json = String(response.headers['content-type'] ?? '').includes('application/json');
    const body = response.body && json ? response.json() : undefined;
    if (body?.csrfToken) this.csrf = body.csrfToken;
    return { status: response.statusCode, body, text: response.body, raw: response.rawPayload, headers: response.headers };
  }

  get = (path: string, headers?: Record<string, string>) => this.request('GET', path, undefined, headers);
  post = (path: string, payload?: unknown, headers?: Record<string, string>) => this.request('POST', path, payload ?? {}, headers);
  patch = (path: string, payload?: unknown) => this.request('PATCH', path, payload ?? {});
  delete = (path: string) => this.request('DELETE', path);
}

export const PASSWORD = 'correct horse battery staple';

export async function registerOwner(app: NestFastifyApplication, label = unique()) {
  const client = new Client(app);
  const email = `owner-${label}@rentflow.test`;
  const response = await client.post('/auth/register', {
    email,
    password: PASSWORD,
    name: `Owner ${label}`,
    organizationName: `Org ${label}`,
  });
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${response.text}`);
  // New workspaces require owner two-step sign-in; tests opt in where they cover it.
  await prismaOf(app).organization.update({ where: { id: response.body.organization.id }, data: { requireOwnerMfa: false } });
  return { client, email, profile: response.body };
}

/** Property + unit + tenant + lease through the public API. */
export async function createRental(
  client: Client,
  options: {
    startDate?: string;
    endDate?: string;
    rent?: string;
    billingDay?: number;
    dueDay?: number;
    gracePeriodDays?: number;
    firstMonth?: 'FULL' | 'PRORATED' | 'NONE';
    depositRequired?: string;
  } = {},
) {
  const label = unique();
  const property = await client.post('/properties', {
    name: `Building ${label}`,
    type: 'Apartment',
    address: `${label} Mabini Street`,
    city: 'Cebu City',
  });
  const unit = await client.post(`/properties/${property.body.id}/units`, {
    number: `U-${label}`,
    type: 'Studio',
    monthlyRent: options.rent ?? '10000.00',
  });
  const tenant = await client.post('/tenants', {
    firstName: 'Tenant',
    lastName: label,
    email: `tenant-${label}@example.test`,
    phone: '+63 917 000 0000',
  });
  const lease = await client.post('/leases', {
    unitId: unit.body.id,
    tenantId: tenant.body.id,
    startDate: options.startDate ?? monthStart(0),
    endDate: options.endDate,
    monthlyRent: options.rent ?? '10000.00',
    billingDay: options.billingDay ?? 1,
    dueDay: options.dueDay ?? 5,
    gracePeriodDays: options.gracePeriodDays,
    firstMonth: options.firstMonth,
    depositRequired: options.depositRequired,
  });
  if (lease.status !== 201) throw new Error(`lease failed: ${lease.status} ${lease.text}`);
  return { property: property.body, unit: unit.body, tenant: tenant.body, lease: lease.body };
}

export function prismaOf(app: NestFastifyApplication): PrismaService {
  return app.get(PrismaService);
}

export function lastEmail(app: NestFastifyApplication, to: string) {
  const outbox = app.get(MailerService).outbox;
  return [...outbox].reverse().find((message) => message.to === to);
}

export function tokenIn(text: string | undefined): string {
  const match = text?.match(/#token=([\w-]+)/);
  if (!match) throw new Error('no token link in email');
  return match[1]!;
}
