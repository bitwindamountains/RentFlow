import fastifyCookie from '@fastify/cookie';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('authenticated rental transaction flow', () => {
  let app: NestFastifyApplication;
  let cookie = '';
  let csrf = '';
  let propertyId = '';
  let unitId = '';
  let tenantId = '';
  let leaseId = '';
  let chargeId = '';

  beforeAll(async () => {
    process.env['USE_IN_MEMORY_STORE'] = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.register(fastifyCookie);
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env['USE_IN_MEMORY_STORE'];
  });

  const request = async (
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
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
      body: response.body ? response.json() : undefined,
      headers: response.headers,
    };
  };

  it('rejects unauthenticated access', async () => {
    expect((await request('GET', '/api/v1/dashboard')).status).toBe(401);
  });

  it('registers the owner and establishes a secure session', async () => {
    const response = await request('POST', '/api/v1/auth/register', {
      email: 'owner@rentflow.test',
      password: 'correct horse battery staple',
      name: 'Alex Santos',
      organizationName: 'Cebu Prime Rentals',
    });
    expect(response.status).toBe(201);
    cookie = String(response.headers['set-cookie']).split(';')[0];
    csrf = response.body.csrfToken;
    expect(cookie).toContain('rentflow_session=');
    expect(response.body.role).toBe('OWNER');
  });

  it('rejects a state-changing request with an invalid CSRF token', async () => {
    const response = await request(
      'POST',
      '/api/v1/properties',
      {
        name: 'Blocked Property',
        type: 'Apartment',
        address: '1 Blocked Street',
        city: 'Cebu City',
      },
      { 'x-csrf-token': 'invalid-token' },
    );
    expect(response.status).toBe(401);
  });

  it('creates a property and rentable unit', async () => {
    const property = await request('POST', '/api/v1/properties', {
      name: 'Sunrise Apartments',
      type: 'Apartment',
      address: '1 Sunrise Street, Lahug',
      city: 'Cebu City',
    });
    expect(property.status).toBe(201);
    propertyId = property.body.id;
    const unit = await request(
      'POST',
      `/api/v1/properties/${propertyId}/units`,
      { number: '201', type: 'Studio', monthlyRent: '6500.00' },
    );
    expect(unit.status).toBe(201);
    expect(unit.body.monthlyRent).toBe('6500.00');
    unitId = unit.body.id;
  });

  it('creates a tenant and active lease', async () => {
    const tenant = await request('POST', '/api/v1/tenants', {
      firstName: 'Maria',
      lastName: 'Santos',
      email: 'maria@example.test',
      phone: '+639171234567',
    });
    tenantId = tenant.body.id;
    const lease = await request('POST', '/api/v1/leases', {
      unitId,
      tenantId,
      startDate: '2026-09-01',
      monthlyRent: '6500.00',
      billingDay: 1,
      dueDay: 5,
    });
    expect(lease.status).toBe(201);
    expect(lease.body.status).toBe('ACTIVE');
    leaseId = lease.body.id;
  });

  it('posts one idempotent rent charge', async () => {
    const payload = {
      leaseId,
      type: 'RENT',
      description: 'September 2026 rent',
      amount: '6500.00',
      dueDate: '2026-09-05',
      billingPeriod: '2026-09',
    };
    const first = await request('POST', '/api/v1/charges', payload, {
      'idempotency-key': 'rent-2026-09-maria',
    });
    const retry = await request('POST', '/api/v1/charges', payload, {
      'idempotency-key': 'rent-2026-09-maria',
    });
    expect(first.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    chargeId = first.body.id;
    expect((await request('GET', '/api/v1/charges')).body).toHaveLength(1);
  });

  it('posts and allocates an idempotent partial payment', async () => {
    const payload = {
      tenantId,
      leaseId,
      amount: '5000.00',
      method: 'GCASH',
      referenceNumber: 'GCASH-12345',
      paidAt: '2026-09-14T10:00:00.000Z',
      allocations: [{ chargeId, amount: '5000.00' }],
    };
    const first = await request('POST', '/api/v1/payments', payload, {
      'idempotency-key': 'payment-gcash-12345',
    });
    const retry = await request('POST', '/api/v1/payments', payload, {
      'idempotency-key': 'payment-gcash-12345',
    });
    expect(first.status).toBe(201);
    expect(first.body.receiptNumber).toMatch(/CEBU-2026-000001/);
    expect(retry.body.id).toBe(first.body.id);
    expect((await request('GET', '/api/v1/payments')).body).toHaveLength(1);
  });

  it('derives dashboard and immutable ledger balances', async () => {
    const dashboard = await request('GET', '/api/v1/dashboard');
    expect(dashboard.body).toMatchObject({
      expected: '6500.00',
      collected: '5000.00',
      outstanding: '1500.00',
      activeLeases: 1,
      occupiedUnits: 1,
      totalUnits: 1,
      collectionRate: 76.9,
    });
    const ledger = await request('GET', `/api/v1/leases/${leaseId}/ledger`);
    expect(ledger.body).toHaveLength(2);
    expect(ledger.body[1].balance).toBe('1500.00');
  });

  it('prevents a second organization from reading the first ledger', async () => {
    cookie = '';
    csrf = '';
    const registration = await request('POST', '/api/v1/auth/register', {
      email: 'other@rentflow.test',
      password: 'another secure passphrase',
      name: 'Other Owner',
      organizationName: 'Other Rentals',
    });
    cookie = String(registration.headers['set-cookie']).split(';')[0];
    csrf = registration.body.csrfToken;
    expect(
      (await request('GET', `/api/v1/leases/${leaseId}/ledger`)).status,
    ).toBe(404);
  });

  it('invalidates the session on logout', async () => {
    expect((await request('POST', '/api/v1/auth/logout', {})).status).toBe(204);
    expect((await request('GET', '/api/v1/dashboard')).status).toBe(401);
  });
});
