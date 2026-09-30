import type { SessionContext } from './domain.store.js';

export const DOMAIN_SERVICE = Symbol('DOMAIN_SERVICE');

export interface DomainService {
  register(input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }): unknown;
  login(email: string, password: string, workspace?: string): unknown;
  getSession(id?: string): unknown;
  logout(id: string): unknown;
  profile(context: SessionContext): unknown;
  listProperties(organizationId: string): unknown;
  createProperty(
    organizationId: string,
    input: { name: string; type: string; address: string; city: string },
  ): unknown;
  createUnit(
    organizationId: string,
    propertyId: string,
    input: { number: string; type: string; monthlyRent: string },
  ): unknown;
  listTenants(organizationId: string): unknown;
  createTenant(
    organizationId: string,
    input: {
      firstName: string;
      lastName: string;
      email?: string;
      phone?: string;
    },
  ): unknown;
  listLeases(organizationId: string): unknown;
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
  ): unknown;
  listCharges(organizationId: string): unknown;
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
    actorUserId?: string,
  ): unknown;
  listPayments(organizationId: string): unknown;
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
    actorUserId?: string,
  ): unknown;
  ledgerForLease(organizationId: string, leaseId: string): unknown;
  dashboard(organizationId: string): unknown;
}
