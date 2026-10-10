import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { firstOfNextMonth } from '../core/dates';
import { DayPipe, LabelPipe, MoneyPipe, statusTone } from '../core/format';
import type { Lease, Property, TenantSummary } from '../core/models';

type Action = 'create' | 'renew' | 'rent' | 'terminate';

interface LeaseDraft {
  unitId: string;
  tenantId: string;
  startDate: string;
  endDate: string;
  monthlyRent: string;
  depositRequired: string;
  billingDay: number;
  dueDay: number;
  gracePeriodDays: number;
  firstMonth: 'FULL' | 'PRORATED' | 'NONE';
  effectiveFrom: string;
  reason: string;
}

@Component({
  selector: 'app-leases-page',
  imports: [FormsModule, RouterLink, MoneyPipe, DayPipe, LabelPipe],
  template: `
<div class="page resource-page">
  <section class="page-heading">
    <div>
      <h1>Leases</h1>
      <p>Agreements, rent terms, renewals, and move-outs.</p>
    </div>
    @if (canManage()) { <button class="primary" type="button" (click)="start('create')">Create lease</button> }
  </section>
  @if (error()) { <p class="inline-notice" role="alert">{{ error() }}</p> }
  @if (notice()) { <p class="inline-notice" role="status">{{ notice() }}</p> }

  @if (action(); as a) {
    <form #editor="ngForm" class="panel operations-form" (ngSubmit)="editor.valid && save()">
      <h2>{{ titles[a] }}</h2>
      <fieldset [disabled]="saving()">
        @switch (a) {
          @case ('create') {
            <div class="field-row">
              <label class="field"><span>Available unit</span>
                <select name="unit" [(ngModel)]="draft.unitId" (ngModelChange)="pickUnit()" required>
                  <option value="">Choose a unit</option>
                  @for (u of availableUnits(); track u.id) { <option [value]="u.id">{{ u.property }} · Unit {{ u.number }}</option> }
                </select></label>
              <label class="field"><span>Tenant</span>
                <select name="tenant" [(ngModel)]="draft.tenantId" required>
                  <option value="">Choose a tenant</option>
                  @for (t of tenants(); track t.id) { <option [value]="t.id">{{ t.firstName }} {{ t.lastName }}</option> }
                </select>
                <small><a routerLink="/tenants">Add a new tenant</a> first if they are not listed.</small></label>
            </div>
            <div class="field-row">
              <label class="field"><span>Move-in date</span><input name="start" type="date" [(ngModel)]="draft.startDate" required /></label>
              <label class="field"><span>End date <em>Optional</em></span><input name="end" type="date" [(ngModel)]="draft.endDate" [min]="draft.startDate" /></label>
            </div>
            <div class="field-row">
              <label class="field"><span>Monthly rent</span>
                <div class="money-input"><b>{{ currency() }}</b><input name="rent" [(ngModel)]="draft.monthlyRent" required pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></div></label>
              <label class="field"><span>Security deposit <em>Optional</em></span>
                <div class="money-input"><b>{{ currency() }}</b><input name="deposit" [(ngModel)]="draft.depositRequired" pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></div></label>
            </div>
            <div class="field-row">
              <label class="field"><span>Bill on day</span><input name="bill" type="number" min="1" max="28" [(ngModel)]="draft.billingDay" required /></label>
              <label class="field"><span>Due on day</span><input name="due" type="number" min="1" max="28" [(ngModel)]="draft.dueDay" required />
                <small>{{ draft.dueDay < draft.billingDay ? 'Due the following month.' : 'Due the same month.' }}</small></label>
              <label class="field"><span>Grace days</span><input name="grace" type="number" min="0" max="60" [(ngModel)]="draft.gracePeriodDays" /></label>
            </div>
            <label class="field"><span>Move-in month</span>
              <select name="firstMonth" [(ngModel)]="draft.firstMonth">
                <option value="FULL">Bill a full month now</option>
                <option value="PRORATED">Bill only the days remaining this month</option>
                <option value="NONE">Do not bill the move-in month</option>
              </select>
              <small>Monthly rent is then billed automatically from {{ nextMonth() | day }}.</small></label>
          }
          @case ('renew') {
            <p>Extends the lease at the current rent. Use Change rent for a new amount.</p>
            <label class="field"><span>New end date</span><input name="end" type="date" [(ngModel)]="draft.endDate" required /></label>
          }
          @case ('rent') {
            <p>Bills already issued keep their amount. The new rent applies from the first bill on or after the effective date.</p>
            <div class="field-row">
              <label class="field"><span>New monthly rent</span>
                <div class="money-input"><b>{{ currency() }}</b><input name="rent" [(ngModel)]="draft.monthlyRent" required pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></div></label>
              <label class="field"><span>Effective from</span><input name="effective" type="date" [(ngModel)]="draft.effectiveFrom" [min]="today()" required /></label>
            </div>
          }
          @case ('terminate') {
            <p>Ends the lease now and frees the unit. Balances and deposits stay for settlement; use Billing to waive or credit unused days.</p>
            <label class="field"><span>Move-out date</span><input name="end" type="date" [(ngModel)]="draft.endDate" [max]="today()" required /></label>
            <label class="field"><span>Reason</span><textarea name="reason" [(ngModel)]="draft.reason" required minlength="3" maxlength="300"></textarea></label>
            <label><input name="confirm" type="checkbox" ngModel required /> I understand this ends the lease immediately.</label>
          }
        }
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" [disabled]="saving()" (click)="action.set(null)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !editor.valid">{{ saving() ? 'Saving…' : 'Confirm' }}</button>
      </div>
    </form>
  }

  <div class="resource-toolbar" role="group" aria-label="Filter leases">
    @for (option of filters; track option) {
      <button type="button" class="filter-button" [attr.aria-pressed]="filter() === option" (click)="filter.set(option)">{{ option | label }}</button>
    }
  </div>
  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Tenant / unit</th><th scope="col">Term</th><th scope="col">Rent</th><th scope="col">Billing</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
      <tbody>
        @for (l of visible(); track l.id) {
          <tr>
            <td><a [routerLink]="['/tenants', l.tenantId]">{{ l.tenantName }}</a><small>{{ l.propertyName }} · Unit {{ l.unit.number }}</small></td>
            <td>{{ l.startDate | day }}<small>{{ l.endDate ? 'to ' + (l.endDate | day) : 'Open-ended' }}</small></td>
            <td>{{ l.monthlyRent | money }}</td>
            <td>Bill {{ l.billingDay }} · due {{ l.dueDay }}<small>{{ l.gracePeriodDays }} grace days</small></td>
            <td><span [class]="tone(l.status)">{{ l.status | label }}</span></td>
            <td>
              @if (canManage() && l.status === 'ACTIVE') {
                <button class="text-button" type="button" (click)="start('renew', l)">Extend</button>
                <button class="text-button" type="button" (click)="start('rent', l)">Change rent</button>
                <button class="text-button" type="button" (click)="start('terminate', l)">End</button>
              }
            </td>
          </tr>
        } @empty {
          <tr><td colspan="6" class="empty-cell">{{ loading() ? 'Loading leases…' : 'No leases here yet.' }}</td></tr>
        }
      </tbody>
    </table>
  </section>
</div>`,
})
export class LeasesPage implements OnInit {
  protected readonly api = inject(ApiClient);
  private readonly preselectUnit = inject(ActivatedRoute).snapshot.queryParamMap.get('unit');
  protected readonly leases = signal<Lease[]>([]);
  protected readonly properties = signal<Property[]>([]);
  protected readonly tenants = signal<TenantSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly action = signal<Action | null>(null);
  protected readonly filters = ['ACTIVE', 'EXPIRED', 'TERMINATED', 'ALL'] as const;
  protected readonly filter = signal<'ACTIVE' | 'EXPIRED' | 'TERMINATED' | 'ALL'>('ACTIVE');
  protected readonly tone = statusTone;
  protected readonly titles: Record<Action, string> = { create: 'Create lease', renew: 'Extend lease', rent: 'Change rent', terminate: 'End lease' };
  protected readonly today = () => this.api.today();
  protected readonly canManage = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected readonly currency = computed(() => this.api.profile()?.organization.currency ?? 'PHP');
  protected readonly visible = computed(() =>
    this.leases().filter((l) => this.filter() === 'ALL' || l.status === this.filter()),
  );
  protected readonly availableUnits = computed(() =>
    this.properties().flatMap((p) => p.units.filter((u) => u.status === 'AVAILABLE').map((u) => ({ ...u, property: p.name }))),
  );
  protected draft!: LeaseDraft;
  private target?: Lease;

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    forkJoin({
      leases: this.api.get<Lease[]>('/leases'),
      properties: this.api.get<Property[]>('/properties'),
      tenants: this.api.get<TenantSummary[]>('/tenants'),
    }).subscribe({
      next: ({ leases, properties, tenants }) => {
        this.leases.set(leases);
        this.properties.set(properties);
        this.tenants.set(tenants);
        this.loading.set(false);
        if (this.preselectUnit && !this.action() && this.canManage()) {
          this.start('create');
          this.draft.unitId = this.preselectUnit;
          this.pickUnit();
        }
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected nextMonth(): string {
    return firstOfNextMonth(this.draft.startDate || this.today());
  }

  protected pickUnit(): void {
    const unit = this.availableUnits().find((u) => u.id === this.draft.unitId);
    if (unit && !this.draft.monthlyRent) this.draft.monthlyRent = unit.monthlyRent;
  }

  protected start(action: Action, lease?: Lease): void {
    this.target = lease;
    this.error.set('');
    this.notice.set('');
    this.draft = {
      unitId: '',
      tenantId: '',
      startDate: this.today(),
      endDate: action === 'terminate' ? this.today() : '',
      monthlyRent: '',
      depositRequired: '',
      billingDay: 1,
      dueDay: 5,
      gracePeriodDays: 0,
      firstMonth: 'FULL',
      effectiveFrom: firstOfNextMonth(this.today()),
      reason: '',
    };
    this.action.set(action);
  }

  protected save(): void {
    const action = this.action();
    if (!action || this.saving()) return;
    const d = this.draft;
    const id = this.target?.id;
    const request =
      action === 'create'
        ? this.api.post('/leases', {
            unitId: d.unitId,
            tenantId: d.tenantId,
            startDate: d.startDate,
            endDate: d.endDate || undefined,
            monthlyRent: d.monthlyRent,
            depositRequired: d.depositRequired || undefined,
            billingDay: Number(d.billingDay),
            dueDay: Number(d.dueDay),
            gracePeriodDays: Number(d.gracePeriodDays || 0),
            firstMonth: d.firstMonth,
          })
        : action === 'renew'
          ? this.api.post(`/leases/${id}/renew`, { endDate: d.endDate })
          : action === 'rent'
            ? this.api.post(`/leases/${id}/rent-change`, { effectiveFrom: d.effectiveFrom, monthlyRent: d.monthlyRent })
            : this.api.post(`/leases/${id}/terminate`, { endDate: d.endDate, reason: d.reason });
    this.saving.set(true);
    this.error.set('');
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.action.set(null);
        this.notice.set(
          action === 'create'
            ? 'Lease created. The move-in charge is posted and monthly rent is scheduled.'
            : action === 'rent'
              ? 'New rent scheduled.'
              : 'Lease updated.',
        );
        this.load();
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }
}
