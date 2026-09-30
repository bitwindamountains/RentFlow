import fastifyCookie from '@fastify/cookie';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const enabled = process.env['RUN_PERSISTENCE_TESTS'] === 'true';

describe.runIf(enabled)('PostgreSQL persistence flow', () => {
  let app: NestFastifyApplication;
  let cookie = '';
  let csrf = '';
  const email = `persistent-${Date.now()}@rentflow.test`;

  async function startApp() {
    delete process.env['USE_IN_MEMORY_STORE'];
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const instance = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await instance.register(fastifyCookie);
    instance.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    instance.setGlobalPrefix('api');
    instance.enableVersioning({
      defaultVersion: '1',
      type: VersioningType.URI,
    });
    await instance.init();
    await instance.getHttpAdapter().getInstance().ready();
    return instance;
  }

  async function request(
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await app.inject({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...headers,
      },
    });
    return {
      status: response.statusCode,
      body: response.json(),
      headers: response.headers,
    };
  }

  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('persists the authenticated accounting flow across an application restart', async () => {
    const registration = await request('POST', '/api/v1/auth/register', {
      email,
      password: 'correct horse battery staple',
      name: 'Persistent Owner',
      organizationName: `Persistence ${Date.now()}`,
    });
    expect(registration.status).toBe(201);
    cookie = String(registration.headers['set-cookie']).split(';')[0];
    csrf = registration.body.csrfToken;
    const property = await request('POST', '/api/v1/properties', {
      name: 'Durable Apartments',
      type: 'Apartment',
      address: '1 Durable Street',
      city: 'Cebu City',
    });
    const unit = await request(
      'POST',
      `/api/v1/properties/${property.body.id}/units`,
      { number: '101', type: 'Studio', monthlyRent: '6500.00' },
    );
    const tenant = await request('POST', '/api/v1/tenants', {
      firstName: 'Maria',
      lastName: 'Durable',
    });
    const lease = await request('POST', '/api/v1/leases', {
      unitId: unit.body.id,
      tenantId: tenant.body.id,
      startDate: '2026-09-01',
      monthlyRent: '6500.00',
      billingDay: 1,
      dueDay: 5,
    });
    const chargePayload = {
      leaseId: lease.body.id,
      type: 'RENT',
      description: 'September rent',
      amount: '6500.00',
      dueDate: '2026-09-05',
      billingPeriod: '2026-09',
    };
    const charge = await request('POST', '/api/v1/charges', chargePayload, {
      'idempotency-key': `charge-${Date.now()}`,
    });
    const payment = await request(
      'POST',
      '/api/v1/payments',
      {
        tenantId: tenant.body.id,
        leaseId: lease.body.id,
        amount: '5000.00',
        method: 'GCASH',
        paidAt: '2026-09-14T10:00:00.000Z',
        allocations: [{ chargeId: charge.body.id, amount: '5000.00' }],
      },
      { 'idempotency-key': `payment-${Date.now()}` },
    );
    expect(payment.body.receiptNumber).toMatch(/-2026-000001$/);

    await app.close();
    cookie = '';
    csrf = '';
    app = await startApp();
    const login = await request('POST', '/api/v1/auth/login', {
      email,
      password: 'correct horse battery staple',
    });
    cookie = String(login.headers['set-cookie']).split(';')[0];
    csrf = login.body.csrfToken;
    const dashboard = await request('GET', '/api/v1/dashboard');
    expect(dashboard.body).toMatchObject({
      expected: '6500.00',
      collected: '5000.00',
      outstanding: '1500.00',
      activeLeases: 1,
    });
    expect(
      (await request('GET', '/api/v1/payments')).body[0].receiptNumber,
    ).toBe(payment.body.receiptNumber);
  });
});
