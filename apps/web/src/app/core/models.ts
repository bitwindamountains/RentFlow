export type Role = 'OWNER' | 'MANAGER' | 'COLLECTOR' | 'VIEWER' | 'MAINTENANCE' | 'TENANT';

/** Where each role lands after signing in, and where it is sent from pages it cannot use. */
export function homeFor(role: Role | null | undefined): string {
  if (role === 'TENANT') return '/portal';
  if (role === 'MAINTENANCE') return '/maintenance';
  return '/dashboard';
}

export interface Profile {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  organization: { id: string; name: string; slug: string; currency: string; timezone: string };
  role: Role;
  csrfToken: string;
  sessionExpiresAt: string;
  workspaces: Array<{ name: string; slug: string; role: Role }>;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Unit {
  id: string;
  propertyId: string;
  number: string;
  type: string;
  monthlyRent: string;
  status: 'AVAILABLE' | 'OCCUPIED' | 'UNAVAILABLE';
  activeLeaseId: string | null;
  activeRent: string | null;
}
export interface Property {
  id: string;
  name: string;
  type: string;
  address: string;
  city: string;
  units: Unit[];
}
export interface TenantSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  balance: string;
  rentals: Array<{ leaseId: string; unitNumber: string; propertyName: string }>;
}
export interface Lease {
  id: string;
  tenantId: string;
  tenantName: string;
  unitId: string;
  unit: { id: string; number: string; type: string };
  propertyId: string;
  propertyName: string;
  startDate: string;
  endDate: string | null;
  monthlyRent: string;
  depositRequired: string;
  billingDay: number;
  dueDay: number;
  gracePeriodDays: number;
  status: 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED' | 'SUPERSEDED';
}
export interface Charge {
  id: string;
  leaseId: string;
  tenantId: string;
  tenantName: string;
  unitNumber: string;
  propertyName: string;
  type: string;
  description: string;
  amount: string;
  paid: string;
  adjusted: string;
  outstanding: string;
  billingPeriod: string | null;
  dueDate: string;
  status: 'POSTED' | 'VOIDED' | 'DRAFT';
}
export interface Payment {
  id: string;
  tenantId: string;
  tenantName: string;
  leaseId: string | null;
  unitNumber: string | null;
  amount: string;
  unallocated: string;
  method: string;
  referenceNumber: string | null;
  paidAt: string;
  status: 'POSTED' | 'REVERSED' | 'PENDING' | 'REFUNDED';
  receiptNumber: string | null;
}
export interface CollectionOption {
  leaseId: string;
  tenantId: string;
  tenantName: string;
  unitNumber: string;
  propertyName: string;
  monthlyRent: string;
  outstanding: string;
  balance: string;
}
export interface Arrears {
  leaseId: string;
  tenantId: string;
  tenantName: string;
  phone: string | null;
  unitNumber: string;
  propertyName: string;
  overdue: string;
  oldestDueDate: string;
  daysOverdue: number;
  chargeCount: number;
  aging: { current: string; days31to60: string; days61to90: string; over90: string };
}
export interface Dashboard {
  asOf: string;
  currency: string;
  month: string;
  billedThisMonth: string;
  collectedThisMonth: string;
  collectionRate: number | null;
  outstanding: string;
  overdue: string;
  activeLeases: number;
  occupiedUnits: number;
  totalUnits: number;
  occupancyRate: number | null;
  leasesEndingSoon: number;
  openMaintenance: number;
  topArrears: Arrears[];
  trend: Array<{ month: string; billed: string; collected: string }>;
}
export interface Reminder {
  id: string;
  type: 'OVERDUE_BALANCE' | 'LEASE_EXPIRY' | 'MAINTENANCE' | 'PAYMENT_NOTICE';
  title: string;
  detail: string;
  route: string;
  severity: 'high' | 'medium';
  leaseId?: string;
  tenantId?: string;
  amount?: string;
}
export interface LedgerEntry {
  id: string;
  type: string;
  occurredAt: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
}
export interface TenantDetail {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
  balance: string;
  leases: Array<{
    id: string;
    status: string;
    startDate: string;
    endDate: string | null;
    monthlyRent: string;
    billingDay: number;
    dueDay: number;
    unitNumber: string;
    propertyId: string;
    propertyName: string;
    deposit: { required: string; held: string } | null;
  }>;
  openCharges: Charge[];
  payments: Array<Omit<Payment, 'tenantName' | 'unitNumber' | 'unallocated'>>;
  documents: DocumentRecord[];
}
export interface Receipt {
  paymentId: string;
  receiptNumber: string | null;
  issuedAt: string | null;
  voided: boolean;
  voidReason: string | null;
  organization: { name: string; currency: string; timezone: string };
  tenantName: string;
  property: { name: string; address: string; unit: string } | null;
  amount: string;
  method: string;
  referenceNumber: string | null;
  paidAt: string;
  lines: Array<{ description: string; billingPeriod: string | null; amount: string }>;
  credit: string;
}

export interface DocumentRecord {
  id: string;
  name: string;
  category: string;
  entityType?: string | null;
  entityId?: string | null;
  /** `file` is stored privately and downloaded through the API; `link` points to external storage. */
  kind: 'file' | 'link';
  url: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  /** Visible to the tenant in the portal (tenant and lease documents only). */
  sharedWithTenant?: boolean;
  createdAt: string;
}

// ----- Tenant portal -----
export interface PortalDocument {
  id: string;
  name: string;
  category: string;
  kind: 'file' | 'link';
  url: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}
export type NoticeStatus = 'SUBMITTED' | 'CONFIRMED' | 'REJECTED' | 'WITHDRAWN';
export interface PaymentNotice {
  id: string;
  leaseId: string;
  amount: string;
  method: string;
  referenceNumber: string | null;
  paidOn: string;
  note: string | null;
  status: NoticeStatus;
  rejectionReason: string | null;
  reviewedAt: string | null;
  paymentId: string | null;
  receiptNumber: string | null;
  createdAt: string;
}
export interface StaffPaymentNotice extends PaymentNotice {
  tenantId: string;
  tenantName: string;
  unitNumber: string;
  propertyName: string;
  leaseOutstanding: string;
  proofs: Array<{ id: string; contentType: string | null }>;
}
export interface PortalPayment {
  id: string;
  amount: string;
  method: string;
  referenceNumber: string | null;
  paidAt: string;
  status: string;
  receiptNumber: string | null;
}
export interface PortalLease {
  id: string;
  status: string;
  propertyName: string;
  address: string;
  unitNumber: string;
  startDate: string;
  endDate: string | null;
  monthlyRent: string;
  dueDay: number;
  gracePeriodDays: number;
  depositHeld: string | null;
}
export interface PortalHome {
  organization: { name: string; currency: string };
  tenant: { firstName: string; lastName: string };
  today: string;
  balance: { outstanding: string; overdue: string; credit: string; nextDue: { date: string; amount: string } | null };
  openCharges: Array<{
    id: string;
    leaseId: string;
    description: string;
    billingPeriod: string | null;
    dueDate: string;
    amount: string;
    outstanding: string;
    overdue: boolean;
  }>;
  leases: PortalLease[];
  recentPayments: PortalPayment[];
  notices: PaymentNotice[];
}
export interface PortalRepair {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  propertyName: string;
  unitNumber: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface PortalAccess {
  status: 'NONE' | 'INVITED' | 'ACTIVE' | 'SUSPENDED';
  email: string | null;
  since: string | null;
  expiresAt?: string;
  link?: string;
}
