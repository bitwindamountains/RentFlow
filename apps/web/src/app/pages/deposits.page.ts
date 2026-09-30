import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ApiClient, isUncertain, type ApiError } from '../core/api-client.service';
import { LabelPipe, MomentPipe, MoneyPipe } from '../core/format';
import type { Lease } from '../core/models';

interface DepositAccount {
  id: string;
  leaseId: string;
  leaseStatus: string;
  tenantName: string;
  unitNumber: string;
  requiredAmount: string;
  balance: string;
  transactions: Array<{ id: string; type: string; amount: string; reason: string | null; occurredAt: string }>;
}

@Component({
  selector: 'app-deposits-page',
  imports: [FormsModule, MoneyPipe, MomentPipe, LabelPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div>
      <p class="eyebrow">MONEY</p>
      <h1>Security deposits</h1>
      <p>Held separately from rent. Deposits never count as income.</p>
    </div>
    @if (canWrite()) { <button class="primary" type="button" (click)="open()">Record deposit</button> }
  </section>
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && save()">
      <fieldset [disabled]="saving() || !!pending">
        <label class="field"><span>Lease</span>
          <select name="lease" [(ngModel)]="draft.leaseId" required>
            @for (l of leases(); track l.id) { <option [value]="l.id">{{ l.tenantName }} · Unit {{ l.unit.number }}</option> }
          </select></label>
        <div class="field-row">
          <label class="field"><span>Transaction</span>
            <select name="type" [(ngModel)]="draft.type">
              <option value="RECEIPT">Received deposit</option><option value="DEDUCTION">Deduction (damage, unpaid)</option>
              <option value="REFUND">Refund to tenant</option><option value="ADJUSTMENT">Adjustment (add)</option>
            </select></label>
          <label class="field"><span>Amount</span><input name="amount" [(ngModel)]="draft.amount" required pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></label>
        </div>
        <label class="field"><span>Reason {{ draft.type === 'RECEIPT' ? '(optional)' : '' }}</span>
          <input name="reason" [(ngModel)]="draft.reason" [required]="draft.type !== 'RECEIPT'" maxlength="300" /></label>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" [disabled]="saving()" (click)="close()">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid">{{ pending ? 'Retry safely' : 'Save' }}</button>
      </div>
    </form>
  }

  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Tenant / unit</th><th scope="col">Required</th><th scope="col">Held</th><th scope="col">Last activity</th></tr></thead>
      <tbody>
        @for (d of deposits(); track d.id) {
          <tr>
            <td><strong>{{ d.tenantName }}</strong><small>Unit {{ d.unitNumber }} · lease {{ d.leaseStatus | label }}</small></td>
            <td>{{ d.requiredAmount | money }}</td>
            <td [class.warning-text]="d.balance !== d.requiredAmount">{{ d.balance | money }}</td>
            <td>@if (d.transactions[0]; as t) { {{ t.type | label }} {{ t.amount | money }}<small>{{ t.occurredAt | moment: 'date' }}{{ t.reason ? ' · ' + t.reason : '' }}</small> } @else { — }</td>
          </tr>
        } @empty { <tr><td colspan="4" class="empty-cell">{{ loading() ? 'Loading…' : 'No deposits recorded yet.' }}</td></tr> }
      </tbody>
    </table>
  </section>
</div>`,
})
export class DepositsPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly deposits = signal<DepositAccount[]>([]);
  protected readonly leases = signal<Lease[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly canWrite = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR'));
  protected draft = { leaseId: '', type: 'RECEIPT', amount: '', reason: '' };
  /** An uncertain submission is retried with the same key and body. */
  protected pending?: { key: string; leaseId: string; body: object };

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    forkJoin({ deposits: this.api.get<DepositAccount[]>('/deposits'), leases: this.api.get<Lease[]>('/leases') }).subscribe({
      next: ({ deposits, leases }) => {
        this.deposits.set(deposits);
        this.leases.set(leases.filter((l) => l.status === 'ACTIVE'));
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected open(): void {
    this.draft = { leaseId: this.leases()[0]?.id ?? '', type: 'RECEIPT', amount: '', reason: '' };
    this.pending = undefined;
    this.error.set('');
    this.formOpen.set(true);
  }

  protected close(): void {
    if (this.pending && !confirm('The last deposit may already be saved. Close without confirming?')) return;
    this.pending = undefined;
    this.formOpen.set(false);
  }

  protected save(): void {
    this.pending ??= {
      key: crypto.randomUUID(),
      leaseId: this.draft.leaseId,
      body: { type: this.draft.type, amount: this.draft.amount, reason: this.draft.reason.trim() || undefined },
    };
    const request = this.pending;
    this.saving.set(true);
    this.error.set('');
    this.api.post(`/leases/${request.leaseId}/deposits`, request.body, request.key).subscribe({
      next: () => {
        this.saving.set(false);
        this.pending = undefined;
        this.formOpen.set(false);
        this.notice.set('Deposit recorded.');
        this.load();
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        if (!isUncertain(error)) this.pending = undefined;
        this.error.set(isUncertain(error) ? 'We could not confirm this deposit. Retry to check safely — it will not be recorded twice.' : error.message);
      },
    });
  }
}
