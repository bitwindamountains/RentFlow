import { DecimalPipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiClient } from '../core/api-client.service';

interface Unit {
  id: string;
  number: string;
  type: string;
  status: string;
  monthlyRent: string;
}
interface Property {
  id: string;
  name: string;
  type: string;
  address: string;
  city: string;
  units: Unit[];
}
interface Tenant {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  balance: string;
}
interface Lease {
  id: string;
  tenantId: string;
  unitId: string;
  startDate: string;
  endDate?: string;
  monthlyRent: string;
  billingDay: number;
  dueDay: number;
  status: string;
  unit: Unit;
}
interface Payment {
  id: string;
  tenantId: string;
  receiptNumber: string;
  referenceNumber?: string;
  method: string;
  paidAt: string;
  amount: string;
  status: string;
}
interface Charge {
  id: string;
  leaseId: string;
  description: string;
  type: string;
  dueDate: string;
  amount: string;
  outstanding: string;
  status: string;
}
type FormKind =
  '' | 'property' | 'unit' | 'tenant' | 'lease' | 'charge' | 'renew' | 'terminate' | 'reverse';

@Component({
  selector: 'app-resource-page',
  imports: [DecimalPipe, FormsModule, RouterLink],
  templateUrl: './resource.page.html',
})
export class ResourcePage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly config = inject(ActivatedRoute).snapshot.data;
  protected readonly profile = this.api.profile;
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly query = signal('');
  protected readonly form = signal<FormKind>('');
  protected readonly selectedProperty = signal('');
  protected readonly editing = signal(false);
  protected readonly properties = signal<Property[]>([]);
  protected readonly tenants = signal<Tenant[]>([]);
  protected readonly leases = signal<Lease[]>([]);
  protected readonly payments = signal<Payment[]>([]);
  protected readonly charges = signal<Charge[]>([]);
  protected readonly canManage = computed(() =>
    ['OWNER', 'MANAGER'].includes(this.profile()?.role ?? ''),
  );
  protected readonly visibleProperties = computed(() =>
    this.properties().filter((x) => this.matches(`${x.name} ${x.address} ${x.city}`)),
  );
  protected readonly visibleTenants = computed(() =>
    this.tenants().filter((x) =>
      this.matches(`${x.firstName} ${x.lastName} ${this.rentals(x.id)}`),
    ),
  );
  protected readonly visiblePayments = computed(() =>
    this.payments().filter((x) =>
      this.matches(
        `${x.receiptNumber} ${this.tenantName(x.tenantId)} ${x.referenceNumber ?? ''} ${x.status} ${x.method}`,
      ),
    ),
  );
  protected readonly activeLeases = computed(() =>
    this.leases().filter((x) => x.status === 'ACTIVE'),
  );
  protected readonly postedPayments = computed(() =>
    this.payments().filter((x) => x.status === 'POSTED'),
  );
  protected readonly collected = computed(() =>
    this.postedPayments().reduce((n, x) => n + Number(x.amount), 0),
  );
  protected readonly availableUnits = computed(() =>
    this.properties().flatMap((p) =>
      p.units.filter((u) => u.status === 'AVAILABLE').map((u) => ({ ...u, property: p.name })),
    ),
  );
  protected draft: Record<string, any> = {};
  private targetId = '';
  private chargeKey = '';
  constructor() {
    this.api.changes.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.config['kind'] === 'payments') this.load();
    });
  }

  ngOnInit(): void {
    this.load();
  }
  private matches(value: string): boolean {
    return value.toLowerCase().includes(this.query().trim().toLowerCase());
  }
  protected tenantName(id: string): string {
    const t = this.tenants().find((x) => x.id === id);
    return t ? `${t.firstName} ${t.lastName}` : 'Unknown tenant';
  }
  protected rentals(id: string): string {
    return (
      this.activeLeases()
        .filter((l) => l.tenantId === id)
        .map(
          (l) =>
            `${this.properties().find((p) => p.units.some((u) => u.id === l.unitId))?.name ?? ''} · Unit ${l.unit.number}`,
        )
        .join(', ') || 'No active lease'
    );
  }
  protected occupied(p: Property): number {
    return p.units.filter((u) => this.activeLeases().some((l) => l.unitId === u.id)).length;
  }
  protected rent(p: Property): number {
    return this.activeLeases()
      .filter((l) => p.units.some((u) => u.id === l.unitId))
      .reduce((n, l) => n + Number(l.monthlyRent), 0);
  }
  protected outstanding(p: Property): number {
    const ids = this.leases()
      .filter((l) => p.units.some((u) => u.id === l.unitId))
      .map((l) => l.id);
    return this.charges()
      .filter((c) => c.status === 'POSTED' && ids.includes(c.leaseId))
      .reduce((n, c) => n + Number(c.outstanding), 0);
  }
  protected outstandingCount(): number {
    return this.charges().filter((c) => c.status === 'POSTED' && Number(c.outstanding) > 0).length;
  }
  protected open(kind: FormKind, id = ''): void {
    this.editing.set(false);
    this.targetId = id;
    this.form.set(kind);
    this.error.set('');
    this.chargeKey = crypto.randomUUID();
    this.draft = {
      name: '',
      type: kind === 'charge' ? 'RENT' : kind === 'unit' ? 'Studio' : 'Apartment',
      address: '',
      city: '',
      number: '',
      monthlyRent: '',
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      unitId: '',
      tenantId: '',
      startDate: new Date().toISOString().slice(0, 10),
      billingDay: 1,
      dueDay: 5,
      endDate: '',
      reason: '',
      leaseId: '',
      amount: '',
      description: '',
      dueDate: new Date().toISOString().slice(0, 10),
    };
  }
  protected editProperty(property: Property): void {
    this.open('property', property.id);
    this.editing.set(true);
    this.draft = { ...property };
  }
  protected editTenant(tenant: Tenant): void {
    this.open('tenant', tenant.id);
    this.editing.set(true);
    this.draft = { ...tenant, email: tenant.email ?? '', phone: tenant.phone ?? '' };
  }
  protected save(valid: boolean | null): void {
    if (!valid || this.saving()) return;
    const d = this.draft;
    let path = '';
    let body: object = {};
    switch (this.form()) {
      case 'property':
        path = '/properties';
        body = { name: d['name'], type: d['type'], address: d['address'], city: d['city'] };
        break;
      case 'unit':
        path = `/properties/${this.targetId}/units`;
        body = { number: d['number'], type: d['type'], monthlyRent: d['monthlyRent'] };
        break;
      case 'tenant':
        path = '/tenants';
        body = {
          firstName: d['firstName'],
          lastName: d['lastName'],
          email: d['email'].trim() || undefined,
          phone: d['phone'] || undefined,
        };
        break;
      case 'lease':
        path = '/leases';
        body = {
          unitId: d['unitId'],
          tenantId: d['tenantId'],
          startDate: d['startDate'],
          endDate: d['endDate'] || undefined,
          monthlyRent: d['monthlyRent'],
          billingDay: d['billingDay'],
          dueDay: d['dueDay'],
        };
        break;
      case 'charge':
        path = '/charges';
        body = {
          leaseId: d['leaseId'],
          type: d['type'],
          description: d['description'],
          amount: d['amount'],
          dueDate: d['dueDate'],
        };
        break;
      case 'renew':
        path = `/leases/${this.targetId}/renew`;
        body = { endDate: d['endDate'] };
        break;
      case 'terminate':
        path = `/leases/${this.targetId}/terminate`;
        body = { endDate: d['endDate'], reason: d['reason'] };
        break;
      case 'reverse':
        path = `/payments/${this.targetId}/reverse`;
        body = { reason: d['reason'] };
        break;
      default:
        return;
    }
    this.saving.set(true);
    this.error.set('');
    const request = this.editing()
      ? this.api.patch(`${path}/${this.targetId}`, body)
      : this.api.post(path, body, this.form() === 'charge' ? this.chargeKey : undefined);
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.form.set('');
        this.notice.set('Saved successfully.');
        this.load();
      },
      error: (e) => {
        this.saving.set(false);
        this.error.set(
          e?.error?.message ?? 'Could not confirm this change. Check the records before retrying.',
        );
      },
    });
  }
  protected generate(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.api.post<{ created: number; skipped: number }>('/billing/run', {}).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.notice.set(`${r.created} charges posted; ${r.skipped} not due or already posted.`);
        this.load();
      },
      error: (e) => {
        this.saving.set(false);
        this.error.set(e?.error?.message ?? 'Billing failed.');
      },
    });
  }
  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    const kind = this.config['kind'];
    forkJoin({
      properties: ['properties', 'tenants', 'leases'].includes(kind)
        ? this.api.get<Property[]>('/properties')
        : of([]),
      tenants: kind !== 'properties' ? this.api.get<Tenant[]>('/tenants') : of([]),
      leases: kind !== 'payments' ? this.api.get<Lease[]>('/leases') : of([]),
      payments: kind === 'payments' ? this.api.get<Payment[]>('/payments') : of([]),
      charges: ['properties', 'billing'].includes(kind)
        ? this.api.get<Charge[]>('/charges')
        : of([]),
    }).subscribe({
      next: (r) => {
        this.properties.set(r.properties);
        this.tenants.set(r.tenants);
        this.leases.set(r.leases);
        this.payments.set(r.payments);
        this.charges.set(r.charges);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load records. Check your connection and try again.');
      },
    });
  }
}
