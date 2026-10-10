import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { LabelPipe, MomentPipe, MoneyPipe, statusTone } from '../core/format';
import type { Page, Payment } from '../core/models';
import { PaymentLauncher } from '../core/payment-launcher.service';
import { PaymentNoticesComponent } from './payment-notices.component';

@Component({
  selector: 'app-payments-page',
  imports: [FormsModule, RouterLink, MoneyPipe, MomentPipe, LabelPipe, PaymentNoticesComponent],
  template: `
<div class="page resource-page">
  <section class="page-heading">
    <div>
      <h1>Payments</h1>
      <p>Every payment received, with its receipt.</p>
    </div>
    @if (canCollect()) { <button class="primary" type="button" (click)="launcher.open()">Record payment</button> }
  </section>
  @if (error()) { <p class="inline-notice" role="alert">{{ error() }}</p> }
  @if (notice()) { <p class="inline-notice" role="status">{{ notice() }}</p> }
  <app-payment-notices (changed)="notice.set($event); load()" />

  @if (reversing(); as p) {
    <form #editor="ngForm" class="panel operations-form" (ngSubmit)="editor.valid && reverse(p)">
      <h2>Reverse payment {{ p.receiptNumber }}</h2>
      <p>Use this for a bounced transfer or a payment entered by mistake. The receipt is voided and the charges it paid become outstanding again. No money is sent back to the tenant.</p>
      <p><strong>{{ p.tenantName }} · {{ p.amount | money }} · {{ p.method | label }}</strong></p>
      <label class="field"><span>Reason</span><textarea name="reason" [(ngModel)]="reason" required minlength="3" maxlength="300"></textarea></label>
      <label><input name="confirm" type="checkbox" ngModel required /> Reverse this payment</label>
      <div class="modal-actions">
        <button class="secondary" type="button" [disabled]="saving()" (click)="reversing.set(null)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !editor.valid">{{ saving() ? 'Reversing…' : 'Reverse payment' }}</button>
      </div>
    </form>
  }

  <div class="resource-toolbar">
    <label class="field"><span>Search receipt, reference, or tenant</span>
      <input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)" (keydown.enter)="load()" (search)="load()" /></label>
    <label class="field"><span>Status</span>
      <select [ngModel]="status()" (ngModelChange)="status.set($event); load()">
        <option value="">All</option><option value="POSTED">Posted</option><option value="REVERSED">Reversed</option>
      </select></label>
  </div>
  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Receipt</th><th scope="col">Tenant</th><th scope="col">Method</th><th scope="col">Paid</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
      <tbody>
        @for (p of payments(); track p.id) {
          <tr>
            <td><a [routerLink]="['/receipts', p.id]">{{ p.receiptNumber ?? 'View' }}</a></td>
            <td><a [routerLink]="['/tenants', p.tenantId]">{{ p.tenantName }}</a>@if (p.unitNumber) { <small>Unit {{ p.unitNumber }}</small> }</td>
            <td>{{ p.method | label }}<small>{{ p.referenceNumber }}</small></td>
            <td>{{ p.paidAt | moment }}</td>
            <td>{{ p.amount | money }}@if (p.unallocated !== '0.00') { <small>{{ p.unallocated | money }} credit</small> }</td>
            <td><span [class]="tone(p.status)">{{ p.status | label }}</span></td>
            <td>@if (canReverse() && p.status === 'POSTED') { <button class="text-button" type="button" (click)="reversing.set(p); reason = ''">Reverse</button> }</td>
          </tr>
        } @empty { <tr><td colspan="7" class="empty-cell">{{ loading() ? 'Loading payments…' : 'No payments found.' }}</td></tr> }
      </tbody>
    </table>
  </section>
  @if (nextCursor()) { <button class="secondary" type="button" [disabled]="loading()" (click)="load(nextCursor()!)">Load more</button> }
</div>`,
})
export class PaymentsPage implements OnInit {
  protected readonly api = inject(ApiClient);
  protected readonly launcher = inject(PaymentLauncher);
  protected readonly payments = signal<Payment[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly status = signal('');
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly reversing = signal<Payment | null>(null);
  protected readonly tone = statusTone;
  protected readonly canCollect = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR'));
  protected readonly canReverse = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected reason = '';

  constructor() {
    this.api.changes.pipe(takeUntilDestroyed()).subscribe(() => this.load());
  }

  ngOnInit(): void {
    this.load();
  }

  protected load(cursor?: string): void {
    this.loading.set(true);
    this.api
      .get<Page<Payment>>('/payments', { q: this.query().trim(), status: this.status(), cursor, limit: 50 })
      .subscribe({
        next: (page) => {
          this.payments.set(cursor ? [...this.payments(), ...page.items] : page.items);
          this.nextCursor.set(page.nextCursor);
          this.loading.set(false);
        },
        error: (error: ApiError) => {
          this.error.set(error.message);
          this.loading.set(false);
        },
      });
  }

  protected reverse(payment: Payment): void {
    this.saving.set(true);
    this.api.post(`/payments/${payment.id}/reverse`, { reason: this.reason }).subscribe({
      next: () => {
        this.saving.set(false);
        this.reversing.set(null);
        this.notice.set(`Payment ${payment.receiptNumber ?? ''} reversed.`);
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }
}
