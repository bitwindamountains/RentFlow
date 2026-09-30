import { Injectable } from '@nestjs/common';
import {
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);

export interface SessionContext {
  sessionId: string;
  csrfToken: string;
  userId: string;
  organizationId: string;
  role: 'OWNER' | 'MANAGER' | 'COLLECTOR' | 'VIEWER' | 'MAINTENANCE';
  expiresAt: Date;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}
export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  currency: 'PHP';
  timezone: 'Asia/Manila';
  receiptCounter: number;
}
export interface PropertyRecord {
  id: string;
  organizationId: string;
  name: string;
  type: string;
  address: string;
  city: string;
}
export interface UnitRecord {
  id: string;
  organizationId: string;
  propertyId: string;
  number: string;
  type: string;
  monthlyRent: number;
  status: 'AVAILABLE' | 'OCCUPIED';
}
export interface TenantRecord {
  id: string;
  organizationId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}
export interface LeaseRecord {
  id: string;
  organizationId: string;
  unitId: string;
  tenantId: string;
  startDate: string;
  endDate?: string;
  monthlyRent: number;
  billingDay: number;
  dueDay: number;
  status: 'ACTIVE' | 'TERMINATED';
}
interface ChargeRecord {
  id: string;
  organizationId: string;
  leaseId: string;
  type: string;
  description: string;
  amount: number;
  dueDate: string;
  billingPeriod?: string;
  status: 'POSTED';
  createdAt: string;
}
interface PaymentRecord {
  id: string;
  organizationId: string;
  tenantId: string;
  leaseId: string;
  amount: number;
  method: string;
  referenceNumber?: string;
  paidAt: string;
  status: 'POSTED' | 'REVERSED';
  receiptNumber: string;
  createdAt: string;
}
interface AllocationRecord {
  id: string;
  paymentId: string;
  chargeId: string;
  amount: number;
}
interface LedgerRecord {
  id: string;
  organizationId: string;
  leaseId: string;
  type: 'CHARGE' | 'PAYMENT' | 'PAYMENT_REVERSAL';
  debit: number;
  credit: number;
  chargeId?: string;
  paymentId?: string;
  occurredAt: string;
}

@Injectable()
export class DomainStore {
  private readonly users: UserRecord[] = [];
  private readonly organizations: OrganizationRecord[] = [];
  private readonly memberships: Array<{
    userId: string;
    organizationId: string;
    role: SessionContext['role'];
  }> = [];
  private readonly sessions = new Map<string, SessionContext>();
  private readonly properties: PropertyRecord[] = [];
  private readonly units: UnitRecord[] = [];
  private readonly tenants: TenantRecord[] = [];
  private readonly leases: LeaseRecord[] = [];
  private readonly charges: ChargeRecord[] = [];
  private readonly payments: PaymentRecord[] = [];
  private readonly allocations: AllocationRecord[] = [];
  private readonly ledger: LedgerRecord[] = [];
  private readonly idempotency = new Map<string, unknown>();

  async register(input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }) {
    const email = input.email.trim().toLocaleLowerCase();
    if (this.users.some((user) => user.email === email))
      throw new Error('EMAIL_EXISTS');
    const user: UserRecord = {
      id: randomUUID(),
      email,
      name: input.name.trim(),
      passwordHash: await this.hashPassword(input.password),
    };
    const organization: OrganizationRecord = {
      id: randomUUID(),
      name: input.organizationName.trim(),
      slug: this.uniqueSlug(input.organizationName),
      currency: 'PHP',
      timezone: 'Asia/Manila',
      receiptCounter: 1,
    };
    this.users.push(user);
    this.organizations.push(organization);
    this.memberships.push({
      userId: user.id,
      organizationId: organization.id,
      role: 'OWNER',
    });
    return {
      user,
      organization,
      session: this.createSession(user.id, organization.id, 'OWNER'),
    };
  }

  async login(emailInput: string, password: string, workspace?: string) {
    const user = this.users.find(
      (candidate) => candidate.email === emailInput.trim().toLocaleLowerCase(),
    );
    if (!user || !(await this.verifyPassword(password, user.passwordHash)))
      return undefined;
    const membership = this.memberships.find(
      (candidate) =>
        candidate.userId === user.id &&
        (!workspace ||
          this.organizations.some(
            (organization) =>
              organization.id === candidate.organizationId &&
              organization.slug === workspace,
          )),
    );
    if (!membership) return undefined;
    const organization = this.organizations.find(
      (candidate) => candidate.id === membership.organizationId,
    )!;
    return {
      user,
      organization,
      session: this.createSession(user.id, organization.id, membership.role),
    };
  }

  getSession(id?: string): SessionContext | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= new Date()) {
      if (session) this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  logout(id: string): void {
    this.sessions.delete(id);
  }

  profile(context: SessionContext) {
    const user = this.users.find(
      (candidate) => candidate.id === context.userId,
    )!;
    const organization = this.organizations.find(
      (candidate) => candidate.id === context.organizationId,
    )!;
    return {
      user: { id: user.id, email: user.email, name: user.name },
      organization: this.publicOrganization(organization),
      role: context.role,
      csrfToken: context.csrfToken,
    };
  }

  listProperties(organizationId: string) {
    return this.properties
      .filter((item) => item.organizationId === organizationId)
      .map((property) => ({
        ...property,
        units: this.units.filter((unit) => unit.propertyId === property.id),
      }));
  }

  createProperty(
    organizationId: string,
    input: { name: string; type: string; address: string; city: string },
  ) {
    const property: PropertyRecord = {
      id: randomUUID(),
      organizationId,
      ...input,
    };
    this.properties.push(property);
    return property;
  }

  createUnit(
    organizationId: string,
    propertyId: string,
    input: { number: string; type: string; monthlyRent: string },
  ) {
    this.requireProperty(organizationId, propertyId);
    if (
      this.units.some(
        (unit) =>
          unit.propertyId === propertyId && unit.number === input.number,
      )
    )
      throw new Error('UNIT_EXISTS');
    const unit: UnitRecord = {
      id: randomUUID(),
      organizationId,
      propertyId,
      number: input.number,
      type: input.type,
      monthlyRent: this.toCentavos(input.monthlyRent),
      status: 'AVAILABLE',
    };
    this.units.push(unit);
    return this.moneyView(unit, ['monthlyRent']);
  }

  listTenants(organizationId: string) {
    return this.tenants
      .filter((item) => item.organizationId === organizationId)
      .map((tenant) => ({
        ...tenant,
        balance: this.formatMoney(this.tenantBalance(tenant.id)),
      }));
  }

  createTenant(
    organizationId: string,
    input: Omit<TenantRecord, 'id' | 'organizationId'>,
  ) {
    const tenant: TenantRecord = { id: randomUUID(), organizationId, ...input };
    this.tenants.push(tenant);
    return { ...tenant, balance: '0.00' };
  }

  listLeases(organizationId: string) {
    return this.leases
      .filter((item) => item.organizationId === organizationId)
      .map((lease) => ({
        ...this.moneyView(lease, ['monthlyRent']),
        tenant: this.tenants.find((item) => item.id === lease.tenantId),
        unit: this.units.find((item) => item.id === lease.unitId),
      }));
  }

  createLease(
    organizationId: string,
    input: {
      unitId: string;
      tenantId: string;
      startDate: string;
      endDate?: string;
      monthlyRent: string;
      billingDay: number;
      dueDay: number;
    },
  ) {
    const unit = this.units.find(
      (item) =>
        item.id === input.unitId && item.organizationId === organizationId,
    );
    const tenant = this.tenants.find(
      (item) =>
        item.id === input.tenantId && item.organizationId === organizationId,
    );
    if (!unit || !tenant) throw new Error('RESOURCE_NOT_FOUND');
    if (
      this.leases.some(
        (lease) => lease.unitId === unit.id && lease.status === 'ACTIVE',
      )
    )
      throw new Error('UNIT_OCCUPIED');
    const lease: LeaseRecord = {
      id: randomUUID(),
      organizationId,
      ...input,
      monthlyRent: this.toCentavos(input.monthlyRent),
      status: 'ACTIVE',
    };
    this.leases.push(lease);
    unit.status = 'OCCUPIED';
    return this.moneyView(lease, ['monthlyRent']);
  }

  listCharges(organizationId: string) {
    return this.charges
      .filter((item) => item.organizationId === organizationId)
      .map((charge) => ({
        ...this.moneyView(charge, ['amount']),
        outstanding: this.formatMoney(this.chargeOutstanding(charge.id)),
      }));
  }

  createCharge(
    organizationId: string,
    input: {
      leaseId: string;
      type: string;
      description: string;
      amount: string;
      dueDate: string;
      billingPeriod?: string;
    },
    idempotencyKey: string,
  ) {
    const cacheKey = `${organizationId}:charge:${idempotencyKey}`;
    if (this.idempotency.has(cacheKey)) return this.idempotency.get(cacheKey);
    const lease = this.leases.find(
      (item) =>
        item.id === input.leaseId &&
        item.organizationId === organizationId &&
        item.status === 'ACTIVE',
    );
    if (!lease) throw new Error('LEASE_NOT_FOUND');
    if (
      input.billingPeriod &&
      this.charges.some(
        (charge) =>
          charge.leaseId === lease.id &&
          charge.type === input.type &&
          charge.billingPeriod === input.billingPeriod,
      )
    )
      throw new Error('CHARGE_EXISTS');
    const charge: ChargeRecord = {
      id: randomUUID(),
      organizationId,
      ...input,
      amount: this.toCentavos(input.amount),
      status: 'POSTED',
      createdAt: new Date().toISOString(),
    };
    this.charges.push(charge);
    this.ledger.push({
      id: randomUUID(),
      organizationId,
      leaseId: lease.id,
      chargeId: charge.id,
      type: 'CHARGE',
      debit: charge.amount,
      credit: 0,
      occurredAt: charge.createdAt,
    });
    const result = this.moneyView(charge, ['amount']);
    this.idempotency.set(cacheKey, result);
    return result;
  }

  listPayments(organizationId: string) {
    return this.payments
      .filter((item) => item.organizationId === organizationId)
      .map((payment) => ({
        ...this.moneyView(payment, ['amount']),
        allocations: this.allocations
          .filter((allocation) => allocation.paymentId === payment.id)
          .map((allocation) => this.moneyView(allocation, ['amount'])),
      }));
  }

  createPayment(
    organizationId: string,
    input: {
      tenantId: string;
      leaseId: string;
      amount: string;
      method: string;
      referenceNumber?: string;
      paidAt: string;
      allocations: Array<{ chargeId: string; amount: string }>;
    },
    idempotencyKey: string,
  ) {
    const cacheKey = `${organizationId}:payment:${idempotencyKey}`;
    if (this.idempotency.has(cacheKey)) return this.idempotency.get(cacheKey);
    const tenant = this.tenants.find(
      (item) =>
        item.id === input.tenantId && item.organizationId === organizationId,
    );
    const lease = this.leases.find(
      (item) =>
        item.id === input.leaseId &&
        item.organizationId === organizationId &&
        item.tenantId === input.tenantId,
    );
    if (!tenant || !lease) throw new Error('LEASE_NOT_FOUND');
    const amount = this.toCentavos(input.amount);
    const prepared = input.allocations.map((allocation) => ({
      chargeId: allocation.chargeId,
      amount: this.toCentavos(allocation.amount),
    }));
    if (
      prepared.reduce((sum, allocation) => sum + allocation.amount, 0) > amount
    )
      throw new Error('ALLOCATION_EXCEEDS_PAYMENT');
    for (const allocation of prepared) {
      const charge = this.charges.find(
        (item) =>
          item.id === allocation.chargeId &&
          item.organizationId === organizationId &&
          item.leaseId === lease.id,
      );
      if (
        !charge ||
        allocation.amount > this.chargeOutstanding(allocation.chargeId)
      )
        throw new Error('INVALID_ALLOCATION');
    }
    const organization = this.organizations.find(
      (item) => item.id === organizationId,
    )!;
    const receiptNumber = `${organization.slug.toUpperCase().slice(0, 4)}-${new Date().getUTCFullYear()}-${String(organization.receiptCounter++).padStart(6, '0')}`;
    const payment: PaymentRecord = {
      id: randomUUID(),
      organizationId,
      tenantId: tenant.id,
      leaseId: lease.id,
      amount,
      method: input.method,
      referenceNumber: input.referenceNumber,
      paidAt: input.paidAt,
      status: 'POSTED',
      receiptNumber,
      createdAt: new Date().toISOString(),
    };
    this.payments.push(payment);
    for (const allocation of prepared)
      this.allocations.push({
        id: randomUUID(),
        paymentId: payment.id,
        ...allocation,
      });
    this.ledger.push({
      id: randomUUID(),
      organizationId,
      leaseId: lease.id,
      paymentId: payment.id,
      type: 'PAYMENT',
      debit: 0,
      credit: amount,
      occurredAt: payment.paidAt,
    });
    const result = {
      ...this.moneyView(payment, ['amount']),
      allocations: prepared.map((allocation) =>
        this.moneyView(allocation, ['amount']),
      ),
    };
    this.idempotency.set(cacheKey, result);
    return result;
  }

  ledgerForLease(organizationId: string, leaseId: string) {
    if (
      !this.leases.some(
        (lease) =>
          lease.id === leaseId && lease.organizationId === organizationId,
      )
    )
      throw new Error('LEASE_NOT_FOUND');
    let balance = 0;
    return this.ledger
      .filter(
        (entry) =>
          entry.organizationId === organizationId && entry.leaseId === leaseId,
      )
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      .map((entry) => {
        balance += entry.debit - entry.credit;
        return {
          ...entry,
          debit: this.formatMoney(entry.debit),
          credit: this.formatMoney(entry.credit),
          balance: this.formatMoney(balance),
        };
      });
  }

  dashboard(organizationId: string) {
    const expected = this.charges
      .filter((item) => item.organizationId === organizationId)
      .reduce((sum, item) => sum + item.amount, 0);
    const collected = this.payments
      .filter(
        (item) =>
          item.organizationId === organizationId && item.status === 'POSTED',
      )
      .reduce((sum, item) => sum + item.amount, 0);
    const organizationUnits = this.units.filter(
      (item) => item.organizationId === organizationId,
    );
    return {
      expected: this.formatMoney(expected),
      collected: this.formatMoney(collected),
      outstanding: this.formatMoney(Math.max(0, expected - collected)),
      activeLeases: this.leases.filter(
        (item) =>
          item.organizationId === organizationId && item.status === 'ACTIVE',
      ).length,
      occupiedUnits: organizationUnits.filter(
        (item) => item.status === 'OCCUPIED',
      ).length,
      totalUnits: organizationUnits.length,
      collectionRate: expected
        ? Number(((collected / expected) * 100).toFixed(1))
        : 0,
    };
  }

  private createSession(
    userId: string,
    organizationId: string,
    role: SessionContext['role'],
  ): SessionContext {
    const session: SessionContext = {
      sessionId: randomBytes(32).toString('base64url'),
      csrfToken: randomBytes(24).toString('base64url'),
      userId,
      organizationId,
      role,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `${salt.toString('hex')}:${derived.toString('hex')}`;
  }

  private async verifyPassword(
    password: string,
    stored: string,
  ): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(':');
    const hash = Buffer.from(hashHex, 'hex');
    const derived = (await scrypt(
      password,
      Buffer.from(saltHex, 'hex'),
      hash.length,
    )) as Buffer;
    return timingSafeEqual(hash, derived);
  }

  private uniqueSlug(name: string): string {
    const base =
      name
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'organization';
    let slug = base;
    let suffix = 2;
    while (this.organizations.some((item) => item.slug === slug))
      slug = `${base}-${suffix++}`;
    return slug;
  }
  private publicOrganization(organization: OrganizationRecord) {
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      currency: organization.currency,
      timezone: organization.timezone,
    };
  }
  private requireProperty(organizationId: string, propertyId: string) {
    const property = this.properties.find(
      (item) =>
        item.id === propertyId && item.organizationId === organizationId,
    );
    if (!property) throw new Error('PROPERTY_NOT_FOUND');
    return property;
  }
  private toCentavos(value: string): number {
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('INVALID_MONEY');
    const centavos = Math.round(Number(value) * 100);
    if (!Number.isSafeInteger(centavos) || centavos <= 0)
      throw new Error('INVALID_MONEY');
    return centavos;
  }
  private formatMoney(centavos: number): string {
    return (centavos / 100).toFixed(2);
  }
  private moneyView<T extends object>(
    record: T,
    keys: string[],
  ): Record<string, unknown> {
    const result = { ...record } as Record<string, unknown>;
    for (const key of keys)
      result[key] = this.formatMoney(result[key] as number);
    return result;
  }
  private chargeOutstanding(chargeId: string): number {
    const charge = this.charges.find((item) => item.id === chargeId);
    if (!charge) return 0;
    const allocated = this.allocations
      .filter((item) => item.chargeId === chargeId)
      .reduce((sum, item) => sum + item.amount, 0);
    return Math.max(0, charge.amount - allocated);
  }
  private tenantBalance(tenantId: string): number {
    const leaseIds = this.leases
      .filter((item) => item.tenantId === tenantId)
      .map((item) => item.id);
    return this.ledger
      .filter((entry) => leaseIds.includes(entry.leaseId))
      .reduce((sum, entry) => sum + entry.debit - entry.credit, 0);
  }
}
