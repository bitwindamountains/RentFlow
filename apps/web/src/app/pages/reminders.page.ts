import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { MomentPipe, MoneyPipe } from '../core/format';
import type { Reminder, ReminderDelivery, ReminderRules } from '../core/models';
import { PaymentLauncher } from '../core/payment-launcher.service';
import { describeTenantSchedule, parseDays } from '../core/reminder-rules';

const KIND_LABELS: Record<ReminderDelivery['kind'], string> = {
  RENT_DUE_SOON: 'Due soon',
  RENT_DUE_TODAY: 'Due today',
  RENT_OVERDUE: 'Overdue',
  LEASE_EXPIRING: 'Lease ending',
};

@Component({
  selector: 'app-reminders-page',
  imports: [RouterLink, FormsModule, MoneyPipe, MomentPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><p class="eyebrow">TODAY</p><h1>Reminders</h1><p>Overdue balances, leases ending within 30 days, and urgent repairs.</p></div>
  </section>
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }
  <section class="panel">
    <div class="attention-list">
      @for (item of reminders(); track item.type + item.id) {
        <div class="attention-item">
          <span [class]="'attention-icon ' + (item.severity === 'high' ? 'red' : 'orange')" aria-hidden="true">!</span>
          <a [routerLink]="item.route"><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></a>
          @if (item.type === 'OVERDUE_BALANCE' && item.leaseId && canCollect()) {
            <button class="secondary" type="button" (click)="payments.open(item.leaseId)">Collect</button>
          }
        </div>
      } @empty {
        <div class="empty-cell">{{ loading() ? 'Loading…' : 'You’re all caught up.' }}</div>
      }
    </div>
  </section>

  @if (canManage() && rules(); as current) {
    <form class="panel operations-form reminder-rules" (ngSubmit)="save()">
      <div class="panel-title">
        <div><h2>Automatic emails</h2><p>Sent by RentFlow each morning from 8:00, at most once per step.</p></div>
      </div>
      @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
      @if (formError()) { <div class="inline-notice" role="alert">{{ formError() }}</div> }
      <fieldset [disabled]="saving()">
        <label class="check-row">
          <input type="checkbox" name="tenantReminders" [(ngModel)]="draft.tenantReminders" />
          <span><strong>Email tenants about rent</strong><small>Only tenants with an email address. Paid balances and tenants who reported a payment are skipped.</small></span>
        </label>
        @if (draft.tenantReminders) {
          <div class="rule-group">
            <div class="field-row">
              <label class="field"><span>Before the due date</span>
                <select name="daysBeforeDue" [(ngModel)]="draft.daysBeforeDue">
                  <option [ngValue]="0">Don’t send</option>
                  @for (d of beforeOptions; track d) { <option [ngValue]="d">{{ d }} {{ d === 1 ? 'day' : 'days' }} before</option> }
                </select>
              </label>
              <label class="field"><span>After it’s overdue <em>days, up to 3</em></span>
                <input name="overdueDays" [(ngModel)]="overdueText" inputmode="numeric" placeholder="3, 7" autocomplete="off" />
                <small>Counted from the end of each lease’s grace period.</small>
              </label>
            </div>
            <label class="check-row">
              <input type="checkbox" name="onDueDate" [(ngModel)]="draft.onDueDate" />
              <span><strong>On the due date</strong></span>
            </label>
            <p class="rule-summary">{{ summary() }}</p>
          </div>
        }
        <label class="check-row">
          <input type="checkbox" name="staffLeaseAlerts" [(ngModel)]="draft.staffLeaseAlerts" />
          <span><strong>Email owners and managers before a lease ends</strong><small>Goes to everyone with a verified email in those roles.</small></span>
        </label>
        @if (draft.staffLeaseAlerts) {
          <div class="rule-group">
            <label class="field"><span>Days before the end date <em>up to 3</em></span>
              <input name="leaseExpiryDays" [(ngModel)]="expiryText" inputmode="numeric" placeholder="60, 30, 7" autocomplete="off" />
            </label>
          </div>
        }
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="reset(current)" [disabled]="saving()">Undo changes</button>
        <button class="primary" type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save' }}</button>
      </div>
    </form>

    <section class="panel">
      <div class="panel-title"><div><h2>Recently sent</h2><p>The last 50 automatic emails.</p></div></div>
      <div class="attention-list">
        @for (d of sent(); track d.id) {
          <a class="attention-item" [routerLink]="d.kind === 'LEASE_EXPIRING' ? '/leases' : ['/tenants', d.tenantId]">
            <span [class]="'attention-icon ' + (d.status === 'SENT' ? 'green' : d.status === 'FAILED' ? 'red' : 'blue')" aria-hidden="true">{{ d.status === 'SENT' ? '✓' : d.status === 'FAILED' ? '×' : '–' }}</span>
            <span>
              <strong>{{ kindLabel(d.kind) }} · {{ d.tenantName }} · Unit {{ d.unitNumber }}</strong>
              <small>
                @if (d.amount) { {{ d.amount | money }} · }
                @if (d.status === 'SENT') { {{ d.kind === 'LEASE_EXPIRING' ? 'to ' + d.recipients + (d.recipients === 1 ? ' person' : ' people') + ' · ' : '' }}sent {{ d.sentAt | moment }} }
                @else if (d.status === 'FAILED') { not delivered }
                @else { no one to send to }
              </small>
            </span>
          </a>
        } @empty {
          <p class="empty-cell">Nothing sent yet.</p>
        }
      </div>
    </section>
  }
</div>`,
  styles: `
    .reminder-rules .check-row {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: var(--space-3);
      align-items: start;
      margin-bottom: var(--space-4);
      cursor: pointer;
    }
    .reminder-rules .check-row input { margin: 3px 0 0; }
    .reminder-rules .check-row span { display: grid; gap: 2px; }
    .reminder-rules .check-row small { color: var(--text-muted); font-size: var(--text-xs); line-height: 1.5; }
    .rule-group {
      margin: 0 0 var(--space-5) calc(18px + var(--space-3));
      padding-left: var(--space-4);
      border-left: 2px solid var(--border);
    }
    .rule-summary { margin: 0; }
    @media (max-width: 640px) {
      .rule-group { margin-left: 0; }
    }
  `,
})
export class RemindersPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly payments = inject(PaymentLauncher);
  protected readonly reminders = signal<Reminder[]>([]);
  protected readonly rules = signal<ReminderRules | null>(null);
  protected readonly sent = signal<ReminderDelivery[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly formError = signal('');
  protected readonly notice = signal('');
  protected readonly canCollect = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR'));
  protected readonly canManage = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected readonly beforeOptions = [1, 2, 3, 5, 7, 14];

  protected draft: ReminderRules = {
    tenantReminders: false,
    daysBeforeDue: 3,
    onDueDate: true,
    overdueDays: [],
    staffLeaseAlerts: true,
    leaseExpiryDays: [],
  };
  protected overdueText = '';
  protected expiryText = '';

  ngOnInit(): void {
    this.loading.set(true);
    this.api.get<Reminder[]>('/reminders').subscribe({
      next: (rows) => {
        this.reminders.set(rows);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
    if (this.canManage()) {
      this.api.get<ReminderRules>('/settings/reminders').subscribe({
        next: (rules) => this.reset(rules),
        error: (error: ApiError) => this.error.set(error.message),
      });
      this.loadSent();
    }
  }

  protected summary(): string {
    return describeTenantSchedule({ ...this.draft, overdueDays: parseDays(this.overdueText, 1, 60) ?? [] });
  }

  protected kindLabel(kind: ReminderDelivery['kind']): string {
    return KIND_LABELS[kind];
  }

  protected reset(rules: ReminderRules): void {
    this.rules.set(rules);
    this.draft = { ...rules };
    this.overdueText = rules.overdueDays.join(', ');
    this.expiryText = rules.leaseExpiryDays.join(', ');
    this.formError.set('');
  }

  protected save(): void {
    this.notice.set('');
    const overdueDays = parseDays(this.overdueText, 1, 60);
    const leaseExpiryDays = parseDays(this.expiryText, 1, 120);
    if (!overdueDays) return this.formError.set('Overdue reminders: enter up to 3 numbers of days between 1 and 60, like “3, 7”.');
    if (!leaseExpiryDays) return this.formError.set('Lease alerts: enter up to 3 numbers of days between 1 and 120, like “60, 30, 7”.');
    this.formError.set('');
    this.saving.set(true);
    this.api
      .patch<ReminderRules>('/settings/reminders', { ...this.draft, overdueDays, leaseExpiryDays: [...leaseExpiryDays].reverse() })
      .subscribe({
        next: (rules) => {
          this.reset(rules);
          this.saving.set(false);
          this.notice.set(rules.tenantReminders ? 'Saved. Tenants will be emailed on this schedule.' : 'Saved.');
        },
        error: (error: ApiError) => {
          this.formError.set(error.message);
          this.saving.set(false);
        },
      });
  }

  private loadSent(): void {
    this.api.get<ReminderDelivery[]>('/reminders/sent').subscribe({
      next: (rows) => this.sent.set(rows),
      error: () => this.sent.set([]),
    });
  }
}
