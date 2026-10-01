import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, LabelPipe, MomentPipe, MoneyPipe, statusTone } from '../core/format';
import type { LedgerEntry, TenantDetail } from '../core/models';
import { toCents } from '../core/money';
import { PaymentLauncher } from '../core/payment-launcher.service';
import { PortalAccessComponent } from './portal-access.component';
import type { TenantForm } from './tenants.page';

@Component({
  selector: 'app-tenant-detail-page',
  imports: [FormsModule, RouterLink, MoneyPipe, DayPipe, MomentPipe, LabelPipe, PortalAccessComponent],
  template: `
<div class="page resource-page">
  <p><a routerLink="/tenants" class="text-button">&larr; All tenants</a></p>
  @if (error()) { <p class="inline-notice" role="alert">{{ error() }}</p> }
  @if (notice()) { <p class="inline-notice" role="status">{{ notice() }}</p> }
  @if (tenant(); as t) {
    <section class="page-heading">
      <div>
        <p class="eyebrow">TENANT · {{ t.status | label }}</p>
        <h1>{{ t.firstName }} {{ t.lastName }}</h1>
        <p>
          @if (t.phone) { <a [href]="'tel:' + t.phone">Call {{ t.phone }}</a> · <a [href]="'sms:' + t.phone">Text</a> }
          @if (t.email) { · <a [href]="'mailto:' + t.email">{{ t.email }}</a> }
          @if (!t.phone && !t.email) { No contact details yet. }
        </p>
      </div>
      <div class="heading-actions">
        @if (canCollect() && activeLease(); as lease) {
          <button class="primary" type="button" (click)="payments.open(lease.id)">Record payment</button>
        }
        @if (canManage()) {
          <button class="secondary" type="button" (click)="edit(t)">Edit</button>
          @if (t.status !== 'ARCHIVED') { <button class="secondary" type="button" (click)="archive()">Archive</button> }
        }
      </div>
    </section>

    @if (form(); as f) {
      <form #editor="ngForm" class="panel operations-form" (ngSubmit)="editor.valid && save()">
        <h2>Edit tenant</h2>
        <fieldset [disabled]="saving()">
          <div class="field-row">
            <label class="field"><span>First name</span><input name="first" [(ngModel)]="f.firstName" required maxlength="80" /></label>
            <label class="field"><span>Last name</span><input name="last" [(ngModel)]="f.lastName" required maxlength="80" /></label>
          </div>
          <div class="field-row">
            <label class="field"><span>Email <em>Optional</em></span><input name="email" type="email" email [(ngModel)]="f.email" /></label>
            <label class="field"><span>Mobile number <em>Optional</em></span><input name="phone" type="tel" [(ngModel)]="f.phone" pattern="[+0-9 ()-]{7,20}" /></label>
          </div>
        </fieldset>
        <div class="modal-actions">
          <button class="secondary" type="button" (click)="form.set(null)">Cancel</button>
          <button class="primary" type="submit" [disabled]="saving() || !editor.valid">Save</button>
        </div>
      </form>
    }

    @if (canManage()) { <app-portal-access [tenantId]="t.id" [email]="t.email" /> }

    <section class="summary-strip">
      <div><span>Balance</span><strong [class.danger-text]="owes()">{{ t.balance | money }}</strong></div>
      <div><span>Open charges</span><strong>{{ t.openCharges.length }}</strong></div>
      <div><span>Tenant since</span><strong>{{ t.createdAt | moment: 'date' }}</strong></div>
    </section>

    <h2>Leases</h2>
    <section class="data-panel table-wrap">
      <table>
        <thead><tr><th scope="col">Unit</th><th scope="col">Term</th><th scope="col">Rent</th><th scope="col">Deposit</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
        <tbody>
          @for (l of t.leases; track l.id) {
            <tr>
              <td>{{ l.propertyName }}<small>Unit {{ l.unitNumber }}</small></td>
              <td>{{ l.startDate | day }}<small>{{ l.endDate ? 'to ' + (l.endDate | day) : 'Open-ended' }}</small></td>
              <td>{{ l.monthlyRent | money }}<small>Bill day {{ l.billingDay }} · due day {{ l.dueDay }}</small></td>
              <td>@if (l.deposit) { {{ l.deposit.held | money }}<small>of {{ l.deposit.required | money }}</small> } @else { — }</td>
              <td><span [class]="tone(l.status)">{{ l.status | label }}</span></td>
              <td><button class="text-button" type="button" (click)="toggleLedger(l.id)">{{ ledgerFor() === l.id ? 'Hide' : 'Ledger' }}</button></td>
            </tr>
            @if (ledgerFor() === l.id) {
              <tr><td colspan="6">
                <table>
                  <caption class="sr-only">Ledger</caption>
                  <thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col">Charge</th><th scope="col">Credit</th><th scope="col">Balance</th></tr></thead>
                  <tbody>
                    @for (e of ledger(); track e.id) {
                      <tr><td>{{ e.occurredAt | moment: 'date' }}</td><td>{{ e.description }}<small>{{ e.type | label }}</small></td>
                        <td>{{ e.debit === '0.00' ? '' : (e.debit | money) }}</td><td>{{ e.credit === '0.00' ? '' : (e.credit | money) }}</td><td>{{ e.balance | money }}</td></tr>
                    } @empty { <tr><td colspan="5" class="empty-cell">No entries yet.</td></tr> }
                  </tbody>
                </table>
              </td></tr>
            }
          } @empty { <tr><td colspan="6" class="empty-cell">No leases. <a routerLink="/leases">Create a lease</a>.</td></tr> }
        </tbody>
      </table>
    </section>

    <h2>Open charges</h2>
    <section class="data-panel table-wrap">
      <table>
        <thead><tr><th scope="col">Charge</th><th scope="col">Due</th><th scope="col">Amount</th><th scope="col">Outstanding</th></tr></thead>
        <tbody>
          @for (c of t.openCharges; track c.id) {
            <tr><td>{{ c.description }}<small>Unit {{ c.unitNumber }}</small></td><td [class.danger-text]="c.dueDate < today()">{{ c.dueDate | day }}</td>
              <td>{{ c.amount | money }}</td><td>{{ c.outstanding | money }}</td></tr>
          } @empty { <tr><td colspan="4" class="empty-cell">Nothing owed.</td></tr> }
        </tbody>
      </table>
    </section>

    <h2>Payments</h2>
    <section class="data-panel table-wrap">
      <table>
        <thead><tr><th scope="col">Receipt</th><th scope="col">Paid</th><th scope="col">Method</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
        <tbody>
          @for (p of t.payments; track p.id) {
            <tr><td><a [routerLink]="['/receipts', p.id]">{{ p.receiptNumber ?? 'View' }}</a></td><td>{{ p.paidAt | moment: 'date' }}</td>
              <td>{{ p.method | label }}<small>{{ p.referenceNumber }}</small></td><td>{{ p.amount | money }}</td><td><span [class]="tone(p.status)">{{ p.status | label }}</span></td></tr>
          } @empty { <tr><td colspan="5" class="empty-cell">No payments yet.</td></tr> }
        </tbody>
      </table>
    </section>

    <h2>Documents</h2>
    <ul>
      @for (d of t.documents; track d.id) { <li><a [href]="d.kind === 'file' ? api.downloadUrl('/documents/' + d.id + '/file') : d.url" target="_blank" rel="noopener noreferrer">{{ d.name }}</a> · {{ d.category }}</li> }
      @empty { <li>No documents. <a routerLink="/documents" [queryParams]="{ entityType: 'Tenant', entityId: t.id }">Link one</a>.</li> }
    </ul>
  } @else if (loading()) {
    <p role="status">Loading tenant…</p>
  }
</div>`,
})
export class TenantDetailPage implements OnInit {
  protected readonly api = inject(ApiClient);
  protected readonly payments = inject(PaymentLauncher);
  private readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  protected readonly tenant = signal<TenantDetail | null>(null);
  protected readonly ledger = signal<LedgerEntry[]>([]);
  protected readonly ledgerFor = signal('');
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly form = signal<TenantForm | null>(null);
  protected readonly tone = statusTone;
  protected readonly today = () => this.api.today();
  protected readonly canManage = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected readonly canCollect = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR'));
  protected readonly owes = computed(() => toCents(this.tenant()?.balance) > 0);
  protected readonly activeLease = computed(() => this.tenant()?.leases.find((l) => l.status === 'ACTIVE'));

  constructor() {
    this.api.changes.pipe(takeUntilDestroyed()).subscribe(() => this.load());
  }

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.api.get<TenantDetail>(`/tenants/${this.id}`).subscribe({
      next: (tenant) => {
        this.tenant.set(tenant);
        this.loading.set(false);
        if (this.ledgerFor()) this.loadLedger(this.ledgerFor());
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected toggleLedger(leaseId: string): void {
    if (this.ledgerFor() === leaseId) {
      this.ledgerFor.set('');
      return;
    }
    this.ledgerFor.set(leaseId);
    this.loadLedger(leaseId);
  }

  private loadLedger(leaseId: string): void {
    this.api.get<LedgerEntry[]>(`/leases/${leaseId}/ledger`).subscribe({
      next: (rows) => this.ledger.set(rows),
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected edit(t: TenantDetail): void {
    this.form.set({ id: t.id, firstName: t.firstName, lastName: t.lastName, email: t.email ?? '', phone: t.phone ?? '' });
  }

  protected save(): void {
    const f = this.form();
    if (!f) return;
    this.saving.set(true);
    this.api
      .patch(`/tenants/${this.id}`, { firstName: f.firstName, lastName: f.lastName, email: f.email.trim() || undefined, phone: f.phone.trim() || undefined })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.form.set(null);
          this.notice.set('Tenant updated.');
        },
        error: (error: ApiError) => {
          this.saving.set(false);
          this.error.set(error.message);
        },
      });
  }

  protected archive(): void {
    if (!confirm('Archive this tenant? Their history is kept, and they are hidden from the tenant list.')) return;
    this.api.post(`/tenants/${this.id}/archive`, {}).subscribe({
      next: () => this.notice.set('Tenant archived.'),
      error: (error: ApiError) => this.error.set(error.message),
    });
  }
}
