import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, LabelPipe, MoneyPipe, statusTone } from '../core/format';
import type { Arrears, Charge, Lease, Page } from '../core/models';
import { PaymentLauncher } from '../core/payment-launcher.service';

type Status = 'open' | 'overdue' | 'all';
type Form =
  | { kind: 'charge'; leaseId: string; type: string; description: string; amount: string; dueDate: string; billingPeriod: string }
  | { kind: 'adjust'; charge: Charge; type: 'DISCOUNT' | 'WAIVER' | 'CREDIT_NOTE'; amount: string; reason: string }
  | { kind: 'void'; charge: Charge; reason: string };

@Component({
  selector: 'app-billing-page',
  imports: [FormsModule, RouterLink, MoneyPipe, DayPipe, LabelPipe],
  template: `
<div class="page resource-page">
  <section class="page-heading">
    <div>
      <p class="eyebrow">{{ api.profile()?.organization?.name }}</p>
      <h1>Billing</h1>
      <p>Who owes what, and every charge on every lease.</p>
    </div>
    @if (canManage()) {
      <div class="heading-actions">
        <button class="secondary" type="button" (click)="openCharge()">Add charge</button>
        <button class="primary" type="button" [disabled]="saving()" (click)="runBilling()">Post due rent</button>
      </div>
    }
  </section>
  @if (error()) { <p class="inline-notice" role="alert">{{ error() }}</p> }
  @if (notice()) { <p class="inline-notice" role="status">{{ notice() }}</p> }

  @if (form(); as f) {
    <form #editor="ngForm" class="panel operations-form" (ngSubmit)="editor.valid && save()">
      <fieldset [disabled]="saving()">
        @switch (f.kind) {
          @case ('charge') {
            <h2>Add a one-off charge</h2>
            <label class="field"><span>Lease</span>
              <select name="lease" [(ngModel)]="f.leaseId" required>
                <option value="">Choose a lease</option>
                @for (l of leases(); track l.id) { <option [value]="l.id">{{ l.tenantName }} · {{ l.propertyName }} · Unit {{ l.unit.number }}</option> }
              </select></label>
            <div class="field-row">
              <label class="field"><span>Type</span>
                <select name="type" [(ngModel)]="f.type">
                  @for (t of chargeTypes; track t) { <option [value]="t">{{ t | label }}</option> }
                </select></label>
              <label class="field"><span>Amount</span>
                <div class="money-input"><b>{{ currency() }}</b><input name="amount" [(ngModel)]="f.amount" required pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></div></label>
            </div>
            <label class="field"><span>Description</span><input name="description" [(ngModel)]="f.description" required minlength="2" maxlength="180" placeholder="e.g. Water — September" /></label>
            <div class="field-row">
              <label class="field"><span>Due date</span><input name="due" type="date" [(ngModel)]="f.dueDate" required /></label>
              @if (f.type === 'RENT') {
                <label class="field"><span>Rent month</span><input name="period" type="month" [(ngModel)]="f.billingPeriod" required />
                  <small>Rent is billed once per month; duplicates are rejected.</small></label>
              }
            </div>
          }
          @case ('adjust') {
            <h2>Reduce a charge</h2>
            <p>{{ f.charge.tenantName }} · {{ f.charge.description }} · {{ f.charge.outstanding | money }} outstanding</p>
            <div class="field-row">
              <label class="field"><span>Adjustment</span>
                <select name="type" [(ngModel)]="f.type"><option value="DISCOUNT">Discount</option><option value="WAIVER">Waiver</option><option value="CREDIT_NOTE">Credit note</option></select></label>
              <label class="field"><span>Amount</span>
                <div class="money-input"><b>{{ currency() }}</b><input name="amount" [(ngModel)]="f.amount" required pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></div></label>
            </div>
            <label class="field"><span>Reason</span><input name="reason" [(ngModel)]="f.reason" required minlength="3" maxlength="300" /></label>
          }
          @case ('void') {
            <h2>Void charge</h2>
            <p>Use this for a charge posted by mistake. It stays in the history as voided. Reverse any payment applied to it first.</p>
            <p><strong>{{ f.charge.tenantName }} · {{ f.charge.description }} · {{ f.charge.amount | money }}</strong></p>
            <label class="field"><span>Reason</span><input name="reason" [(ngModel)]="f.reason" required minlength="3" maxlength="300" /></label>
            <label><input name="confirm" type="checkbox" ngModel required /> Void this charge</label>
          }
        }
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" [disabled]="saving()" (click)="form.set(null)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !editor.valid">{{ saving() ? 'Saving…' : 'Confirm' }}</button>
      </div>
    </form>
  }

  <h2>Arrears</h2>
  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Tenant</th><th scope="col">Overdue</th><th scope="col">Oldest</th><th scope="col">1–30</th><th scope="col">31–60</th><th scope="col">61–90</th><th scope="col">90+</th><th scope="col"></th></tr></thead>
      <tbody>
        @for (a of arrears(); track a.leaseId) {
          <tr>
            <td><a [routerLink]="['/tenants', a.tenantId]">{{ a.tenantName }}</a><small>{{ a.propertyName }} · Unit {{ a.unitNumber }}</small></td>
            <td class="danger-text"><strong>{{ a.overdue | money }}</strong><small>{{ a.daysOverdue }} days</small></td>
            <td>{{ a.oldestDueDate | day }}</td>
            <td>{{ a.aging.current | money }}</td><td>{{ a.aging.days31to60 | money }}</td><td>{{ a.aging.days61to90 | money }}</td><td>{{ a.aging.over90 | money }}</td>
            <td>
              @if (canCollect()) { <button class="secondary" type="button" (click)="payments.open(a.leaseId)">Collect</button> }
              @if (a.phone) { <a class="text-button" [href]="'tel:' + a.phone">Call</a> }
            </td>
          </tr>
        } @empty { <tr><td colspan="8" class="empty-cell">No overdue balances. Everyone is up to date.</td></tr> }
      </tbody>
    </table>
  </section>

  <h2>Charges</h2>
  <div class="resource-toolbar">
    <div role="group" aria-label="Charge status">
      @for (option of statuses; track option) {
        <button type="button" class="filter-button" [attr.aria-pressed]="status() === option" (click)="setStatus(option)">{{ option | label }}</button>
      }
    </div>
    <label class="field"><span>Search tenant, unit, or description</span>
      <input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)" (keydown.enter)="reload()" (search)="reload()" /></label>
  </div>
  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Tenant / unit</th><th scope="col">Charge</th><th scope="col">Due</th><th scope="col">Amount</th><th scope="col">Outstanding</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
      <tbody>
        @for (c of charges(); track c.id) {
          <tr>
            <td><a [routerLink]="['/tenants', c.tenantId]">{{ c.tenantName }}</a><small>Unit {{ c.unitNumber }}</small></td>
            <td>{{ c.description }}<small>{{ c.type | label }}{{ c.billingPeriod ? ' · ' + c.billingPeriod : '' }}</small></td>
            <td [class.danger-text]="c.outstanding !== '0.00' && c.dueDate < today()">{{ c.dueDate | day }}</td>
            <td>{{ c.amount | money }}@if (c.adjusted !== '0.00') { <small>−{{ c.adjusted | money }} adjusted</small> }</td>
            <td>{{ c.outstanding | money }}</td>
            <td><span [class]="tone(c.status)">{{ c.outstanding === '0.00' && c.status === 'POSTED' ? 'Paid' : (c.status | label) }}</span></td>
            <td>
              @if (canManage() && c.status === 'POSTED' && c.outstanding !== '0.00') {
                <button class="text-button" type="button" (click)="adjust(c)">Adjust</button>
              }
              @if (canManage() && c.status === 'POSTED' && c.paid === '0.00') {
                <button class="text-button" type="button" (click)="voidCharge(c)">Void</button>
              }
            </td>
          </tr>
        } @empty { <tr><td colspan="7" class="empty-cell">{{ loading() ? 'Loading charges…' : 'No charges match.' }}</td></tr> }
      </tbody>
    </table>
  </section>
  @if (nextCursor()) {
    <button class="secondary" type="button" [disabled]="loading()" (click)="loadMore()">Load more</button>
  }
</div>`,
})
export class BillingPage implements OnInit {
  protected readonly api = inject(ApiClient);
  protected readonly payments = inject(PaymentLauncher);
  private readonly router = inject(Router);
  protected readonly statuses: Status[] = ['open', 'overdue', 'all'];
  protected readonly chargeTypes = ['RENT', 'ELECTRICITY', 'WATER', 'INTERNET', 'PARKING', 'ASSOCIATION_FEE', 'PENALTY', 'DAMAGE', 'CLEANING', 'OTHER'];
  protected readonly status = signal<Status>(
    (inject(ActivatedRoute).snapshot.queryParamMap.get('status') as Status | null) ?? 'open',
  );
  protected readonly query = signal('');
  protected readonly charges = signal<Charge[]>([]);
  protected readonly arrears = signal<Arrears[]>([]);
  protected readonly leases = signal<Lease[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly form = signal<Form | null>(null);
  protected readonly tone = statusTone;
  protected readonly today = () => this.api.today();
  protected readonly canManage = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected readonly canCollect = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR'));
  protected readonly currency = computed(() => this.api.profile()?.organization.currency ?? 'PHP');
  private chargeKey = crypto.randomUUID();

  constructor() {
    this.api.changes.pipe(takeUntilDestroyed()).subscribe(() => this.reload());
  }

  ngOnInit(): void {
    this.reload();
  }

  protected setStatus(status: Status): void {
    this.status.set(status);
    void this.router.navigate([], { queryParams: { status }, replaceUrl: true });
    this.reload();
  }

  protected reload(): void {
    this.api.get<Arrears[]>('/arrears').subscribe({ next: (rows) => this.arrears.set(rows) });
    this.fetch();
  }

  protected loadMore(): void {
    this.fetch(this.nextCursor() ?? undefined);
  }

  private fetch(cursor?: string): void {
    this.loading.set(true);
    this.api
      .get<Page<Charge>>('/charges', { status: this.status(), q: this.query().trim(), cursor, limit: 50 })
      .subscribe({
        next: (page) => {
          this.charges.set(cursor ? [...this.charges(), ...page.items] : page.items);
          this.nextCursor.set(page.nextCursor);
          this.loading.set(false);
        },
        error: (error: ApiError) => {
          this.error.set(error.message);
          this.loading.set(false);
        },
      });
  }

  protected openCharge(): void {
    this.chargeKey = crypto.randomUUID();
    this.api.get<Lease[]>('/leases').subscribe((rows) => this.leases.set(rows.filter((l) => l.status === 'ACTIVE')));
    const today = this.today();
    this.form.set({ kind: 'charge', leaseId: '', type: 'OTHER', description: '', amount: '', dueDate: today, billingPeriod: today.slice(0, 7) });
  }

  protected adjust(charge: Charge): void {
    this.form.set({ kind: 'adjust', charge, type: 'WAIVER', amount: charge.outstanding, reason: '' });
  }

  protected voidCharge(charge: Charge): void {
    this.form.set({ kind: 'void', charge, reason: '' });
  }

  protected runBilling(): void {
    this.saving.set(true);
    this.api.post<{ created: number }>('/billing/run', {}).subscribe({
      next: (result) => {
        this.saving.set(false);
        this.notice.set(result.created ? `${result.created} due charges posted.` : 'All due rent is already posted.');
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected save(): void {
    const f = this.form();
    if (!f || this.saving()) return;
    const request =
      f.kind === 'charge'
        ? this.api.post(
            '/charges',
            {
              leaseId: f.leaseId,
              type: f.type,
              description: f.description,
              amount: f.amount,
              dueDate: f.dueDate,
              billingPeriod: f.type === 'RENT' ? f.billingPeriod : undefined,
            },
            this.chargeKey,
          )
        : f.kind === 'adjust'
          ? this.api.post(`/charges/${f.charge.id}/adjustments`, { type: f.type, amount: f.amount, reason: f.reason })
          : this.api.post(`/charges/${f.charge.id}/void`, { reason: f.reason });
    this.saving.set(true);
    this.error.set('');
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.form.set(null);
        this.notice.set(f.kind === 'charge' ? 'Charge posted.' : f.kind === 'adjust' ? 'Charge reduced.' : 'Charge voided.');
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }
}
