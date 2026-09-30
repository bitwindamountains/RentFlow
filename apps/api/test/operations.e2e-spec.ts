import fastifyCookie from '@fastify/cookie';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/core/prisma.service.js';

describe.runIf(process.env['RUN_PERSISTENCE_TESTS'] === 'true')(
  'focused operations',
  () => {
    let app: NestFastifyApplication;
    let cookie = '';
    let csrf = '';
    const stamp = Date.now();
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
          ...(method === 'POST' && url.endsWith('/deposits')
            ? { 'idempotency-key': crypto.randomUUID() }
            : {}),
          ...headers,
        },
      });
      const json = String(response.headers['content-type'] ?? '').includes(
        'application/json',
      );
      return {
        status: response.statusCode,
        body: response.body && json ? response.json() : undefined,
        text: response.body,
        headers: response.headers,
      };
    }
    beforeAll(async () => {
      delete process.env['USE_IN_MEMORY_STORE'];
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
    afterAll(async () => app.close());

    it('accepts an existing account once without changing its password or other memberships', async () => {
      const email = `existing-${stamp}@rentflow.test`;
      const password = 'existing account secure password';
      const original = await request('POST', '/api/v1/auth/register', {
        email,
        password,
        name: 'Existing User',
        organizationName: `Original ${stamp}`,
      });
      const owner = await request('POST', '/api/v1/auth/register', {
        email: `inviter-${stamp}@rentflow.test`,
        password,
        name: 'Inviting Owner',
        organizationName: `Inviting ${stamp}`,
      });
      cookie = String(owner.headers['set-cookie']).split(';')[0];
      csrf = owner.body.csrfToken;
      const invite = await request('POST', '/api/v1/staff/invitations', {
        email,
        role: 'COLLECTOR',
      });
      const input = { token: invite.body.token, password };
      expect(
        (
          await request('POST', '/api/v1/staff/invitations/accept', {
            ...input,
            password: 'wrong password',
          })
        ).status,
      ).toBe(401);
      const attempts = await Promise.all([
        request('POST', '/api/v1/staff/invitations/accept', input),
        request('POST', '/api/v1/staff/invitations/accept', input),
      ]);
      expect(attempts.map((item) => item.status).sort()).toEqual([201, 400]);
      const accepted = attempts.find((item) => item.status === 201)!;
      expect(accepted.body.workspace).toBe(owner.body.organization.slug);
      const invitedLogin = await request('POST', '/api/v1/auth/login', {
        email,
        password,
        workspace: accepted.body.workspace,
      });
      expect(invitedLogin.status).toBe(200);
      expect(invitedLogin.body.role).toBe('COLLECTOR');
      expect(invitedLogin.body.user.name).toBe('Existing User');
      expect(invitedLogin.body.organization.id).toBe(
        owner.body.organization.id,
      );
      const originalLogin = await request('POST', '/api/v1/auth/login', {
        email,
        password,
        workspace: original.body.organization.slug,
      });
      expect(originalLogin.body.role).toBe('OWNER');
      expect(
        (
          await request('POST', '/api/v1/auth/login', {
            email,
            password,
            workspace: 'not-a-member',
          })
        ).status,
      ).toBe(401);

      const duplicate = await request('POST', '/api/v1/staff/invitations', {
        email,
        role: 'VIEWER',
      });
      expect(
        (
          await request('POST', '/api/v1/staff/invitations/accept', {
            token: duplicate.body.token,
            password,
          })
        ).body.message,
      ).toBe('ALREADY_A_MEMBER');
      const prisma = app.get(PrismaService);
      await prisma.user.update({
        where: { id: original.body.user.id },
        data: { disabledAt: new Date() },
      });
      expect(
        (
          await request('POST', '/api/v1/staff/invitations/accept', {
            token: duplicate.body.token,
            password,
          })
        ).status,
      ).toBe(401);
      const newInvite = await request('POST', '/api/v1/staff/invitations', {
        email: `new-${stamp}@rentflow.test`,
        role: 'VIEWER',
      });
      expect(
        (
          await request('POST', '/api/v1/staff/invitations/accept', {
            token: newInvite.body.token,
            name: 'New User',
            password: 'short',
          })
        ).status,
      ).toBe(400);
      await prisma.staffInvitation.update({
        where: { id: newInvite.body.id },
        data: { status: 'REVOKED' },
      });
      expect(
        (
          await request('POST', '/api/v1/staff/invitations/accept', {
            token: newInvite.body.token,
            name: 'New User',
            password,
          })
        ).status,
      ).toBe(400);
    });

    it('creates a complete rental once and rejects invalid setup without partial records', async () => {
      const registration = await request('POST', '/api/v1/auth/register', {
        email: `setup-${stamp}@rentflow.test`,
        password: 'correct horse battery staple',
        name: 'Setup Owner',
        organizationName: `Setup ${stamp}`,
      });
      cookie = String(registration.headers['set-cookie']).split(';')[0];
      csrf = registration.body.csrfToken;
      const input = {
        property: {
          name: 'Atomic rental',
          type: 'Apartment',
          address: '12 Test Street',
          city: 'Cebu',
        },
        unit: { number: '1', type: 'Studio', monthlyRent: '6000.00' },
        tenant: { firstName: 'Test', lastName: 'Tenant' },
        lease: {
          startDate: '2026-09-01',
          monthlyRent: '6000.00',
          billingDay: 10,
          dueDay: 15,
        },
        charge: {
          description: 'First rent',
          dueDate: '2026-09-15',
          billingPeriod: '2026-09',
        },
      };
      const headers = { 'idempotency-key': `setup-${stamp}` };
      const first = await request(
        'POST',
        '/api/v1/rental-setup',
        input,
        headers,
      );
      expect(first.status).toBe(201);
      const replay = await request(
        'POST',
        '/api/v1/rental-setup',
        input,
        headers,
      );
      expect(replay.body).toEqual(first.body);
      expect((await request('GET', '/api/v1/properties')).body).toHaveLength(1);
      expect((await request('GET', '/api/v1/charges')).body).toHaveLength(1);
      const tenantEdit = await request(
        'PATCH',
        `/api/v1/tenants/${first.body.tenantId}`,
        { firstName: 'Updated', lastName: 'Tenant', phone: '123456' },
      );
      expect(tenantEdit.status).toBe(200);
      expect((await request('GET', '/api/v1/tenants')).body[0].firstName).toBe(
        'Updated',
      );
      const depositInput = {
        type: 'RECEIPT',
        amount: '500.00',
        reason: 'Deposit',
      };
      const depositHeaders = { 'idempotency-key': `deposit-${stamp}` };
      const deposit = await request(
        'POST',
        `/api/v1/leases/${first.body.leaseId}/deposits`,
        depositInput,
        depositHeaders,
      );
      expect(deposit.status).toBe(201);
      expect(
        (
          await request(
            'POST',
            `/api/v1/leases/${first.body.leaseId}/deposits`,
            depositInput,
            depositHeaders,
          )
        ).body,
      ).toEqual(deposit.body);
      expect((await request('GET', '/api/v1/deposits')).body[0].balance).toBe(
        '500.00',
      );
      expect(
        (
          await request(
            'POST',
            '/api/v1/rental-setup',
            { ...input, unit: { ...input.unit, monthlyRent: '0' } },
            { 'idempotency-key': `invalid-${stamp}` },
          )
        ).status,
      ).toBe(400);
      expect((await request('GET', '/api/v1/properties')).body).toHaveLength(1);
      expect(
        (
          await request(
            'POST',
            '/api/v1/rental-setup',
            { ...input, tenant: { firstName: 'Changed', lastName: 'Tenant' } },
            headers,
          )
        ).status,
      ).toBe(409);
      expect(
        (await request('POST', '/api/v1/billing/run', { asOf: '2026-10-09' }))
          .body.created,
      ).toBe(0);
      expect(
        (await request('POST', '/api/v1/billing/run', { asOf: '2026-10-10' }))
          .body.created,
      ).toBe(1);
      expect(
        (await request('POST', '/api/v1/billing/run', { asOf: '2026-12-10' }))
          .body.created,
      ).toBe(2);
      expect(
        (await request('POST', '/api/v1/billing/run', { asOf: '2026-12-10' }))
          .body.created,
      ).toBe(0);
      const prisma = app.get(PrismaService);
      await prisma.membership.updateMany({
        where: { userId: registration.body.user.id },
        data: { role: 'MAINTENANCE' },
      });
      expect((await request('GET', '/api/v1/payments')).status).toBe(403);
      expect((await request('GET', '/api/v1/documents')).status).toBe(403);
      expect((await request('GET', '/api/v1/maintenance')).status).toBe(200);
      expect(
        (await request('GET', '/api/v1/properties')).body[0],
      ).not.toHaveProperty('units');
      await prisma.membership.updateMany({
        where: { userId: registration.body.user.id },
        data: { status: 'REVOKED' },
      });
      expect((await request('GET', '/api/v1/tenants')).status).toBe(401);
    });

    it('runs the essential landlord operations without duplicate financial writes', async () => {
      const registration = await request('POST', '/api/v1/auth/register', {
        email: `ops-${stamp}@rentflow.test`,
        password: 'correct horse battery staple',
        name: 'Operations Owner',
        organizationName: `Operations ${stamp}`,
      });
      cookie = String(registration.headers['set-cookie']).split(';')[0];
      csrf = registration.body.csrfToken;
      const property = await request('POST', '/api/v1/properties', {
        name: 'Focused Apartments',
        type: 'Apartment',
        address: '1 Focus Street',
        city: 'Cebu City',
      });
      const unit = await request(
        'POST',
        `/api/v1/properties/${property.body.id}/units`,
        { number: 'A1', type: 'Studio', monthlyRent: '7000.00' },
      );
      const tenant = await request('POST', '/api/v1/tenants', {
        firstName: 'Core',
        lastName: 'Tenant',
      });
      const lease = await request('POST', '/api/v1/leases', {
        unitId: unit.body.id,
        tenantId: tenant.body.id,
        startDate: '2026-09-01',
        endDate: '2027-08-31',
        monthlyRent: '7000.00',
        billingDay: 1,
        dueDay: 5,
      });
      expect(
        (await request('GET', '/api/v1/billing-schedules')).body,
      ).toHaveLength(1);
      const billed = await request('POST', '/api/v1/billing/run', {
        asOf: '2026-10-01',
      });
      const rerun = await request('POST', '/api/v1/billing/run', {
        asOf: '2026-10-01',
      });
      expect(billed.body.created).toBe(1);
      expect(rerun.body.skipped).toBe(1);
      const charge = (await request('GET', '/api/v1/charges')).body[0];
      const payment = await request(
        'POST',
        '/api/v1/payments',
        {
          tenantId: tenant.body.id,
          leaseId: lease.body.id,
          amount: '1000.00',
          method: 'CASH',
          paidAt: '2026-10-02T10:00:00.000Z',
          allocations: [{ chargeId: charge.id, amount: '1000.00' }],
        },
        { 'idempotency-key': `ops-payment-${stamp}` },
      );
      expect(payment.body.receiptNumber).toBeTruthy();
      expect(
        (
          await request('POST', `/api/v1/payments/${payment.body.id}/reverse`, {
            reason: 'Entered twice',
          })
        ).status,
      ).toBe(201);
      expect(
        (await request('GET', '/api/v1/charges')).body[0].outstanding,
      ).toBe('7000.00');

      expect(
        (
          await request('POST', `/api/v1/leases/${lease.body.id}/deposits`, {
            type: 'RECEIPT',
            amount: '7000.00',
            reason: 'Security deposit',
          })
        ).status,
      ).toBe(201);
      expect((await request('GET', '/api/v1/deposits')).body[0].balance).toBe(
        '7000.00',
      );
      expect(
        (
          await request('POST', `/api/v1/leases/${lease.body.id}/deposits`, {
            type: 'REFUND',
            amount: '8000.00',
            reason: 'Too much',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('POST', '/api/v1/expenses', {
            propertyId: property.body.id,
            category: 'REPAIR',
            description: 'Replace lock',
            vendor: 'Local Locksmith',
            amount: '850.00',
            incurredOn: '2026-10-03',
          })
        ).status,
      ).toBe(201);
      const maintenance = await request('POST', '/api/v1/maintenance', {
        propertyId: property.body.id,
        title: 'Leaking tap',
        description: 'Kitchen tap needs a washer',
        priority: 'HIGH',
      });
      expect(
        (
          await request('PATCH', `/api/v1/maintenance/${maintenance.body.id}`, {
            status: 'COMPLETED',
          })
        ).body.status,
      ).toBe('COMPLETED');
      expect(
        (
          await request('POST', '/api/v1/documents', {
            name: 'Signed lease',
            category: 'Lease',
            entityType: 'Lease',
            entityId: lease.body.id,
            url: 'https://example.test/signed-lease.pdf',
          })
        ).status,
      ).toBe(201);

      const invite = await request('POST', '/api/v1/staff/invitations', {
        email: `manager-${stamp}@rentflow.test`,
        role: 'MANAGER',
      });
      expect(
        (
          await request('POST', '/api/v1/staff/invitations/accept', {
            token: invite.body.token,
            name: 'Property Manager',
            password: 'another secure passphrase',
          })
        ).body.accepted,
      ).toBe(true);
      expect((await request('GET', '/api/v1/staff')).body.members).toHaveLength(
        2,
      );
      const report = await request('GET', '/api/v1/reports/financial');
      expect(report.body).toMatchObject({
        expected: '7000.00',
        collected: '0.00',
        expenses: '850.00',
        netCash: '-850.00',
      });
      const csv = await request('GET', '/api/v1/reports/transactions.csv');
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text).toContain('Replace lock');
      expect(
        (
          await request('POST', `/api/v1/leases/${lease.body.id}/renew`, {
            endDate: '2028-08-31',
            monthlyRent: '7500.00',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('POST', `/api/v1/leases/${lease.body.id}/renew`, {
            endDate: '2028-08-31',
          })
        ).status,
      ).toBe(201);
      expect(
        (await request('GET', '/api/v1/billing-schedules')).body[0].amount,
      ).toBe('7000.00');
      expect(
        (
          await request('POST', `/api/v1/leases/${lease.body.id}/terminate`, {
            endDate: '2999-01-01',
            reason: 'Future termination must not free the unit',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('POST', `/api/v1/leases/${lease.body.id}/terminate`, {
            endDate: new Date().toISOString().slice(0, 10),
            reason: 'Tenant moved out',
          })
        ).body.status,
      ).toBe('TERMINATED');

      const managerLogin = await request('POST', '/api/v1/auth/login', {
        email: `manager-${stamp}@rentflow.test`,
        password: 'another secure passphrase',
      });
      cookie = String(managerLogin.headers['set-cookie']).split(';')[0];
      csrf = managerLogin.body.csrfToken;
      expect((await request('GET', '/api/v1/reports/financial')).status).toBe(
        200,
      );
      expect(
        (
          await request('POST', '/api/v1/staff/invitations', {
            email: `blocked-${stamp}@rentflow.test`,
            role: 'VIEWER',
          })
        ).status,
      ).toBe(403);
    });
  },
);
