import { Component, type OnInit, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Observable } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, LabelPipe, MoneyPipe } from '../core/format';
import type { StaffPaymentNotice } from '../core/models';
import { appendPage } from '../core/pagination';

/**
 * Payments page: payments that tenants reported in the portal, waiting for staff.
 * Confirming records the payment and issues the receipt; rejecting tells the tenant why.
 */
@Component({
  selector: 'app-payment-notices',
  imports: [FormsModule, RouterLink, MoneyPipe, DayPipe, LabelPipe],
  template: `
@if (error()) { <p class="auth-error" role="alert">{{ error() }}</p> }
@if (notices().length) {
  <section class="panel notices" aria-labelledby="notices-title">
    <div class="panel-title">
      <div>
        <h2 id="notices-title">Reported by tenants <span class="status warning">{{ notices().length }}{{ nextCursor() ? '+' : '' }} to review</span></h2>
        <p>Check each against your GCash, Maya, or bank records before confirming. Confirming records the payment and issues a receipt.</p>
      </div>
    </div>
    <div class="attention-list">
      @for (n of notices(); track n.id) {
        <div class="notice-row">
          <div>
            <strong><a [routerLink]="['/tenants', n.tenantId]">{{ n.tenantName }}</a> · {{ n.amount | money }}</strong>
            <small>
              {{ n.method | label }}{{ n.referenceNumber ? ' · Ref ' + n.referenceNumber : '' }} · paid {{ n.paidOn | day }} ·
              {{ n.propertyName }} Unit {{ n.unitNumber }} · owes {{ n.leaseOutstanding | money }}
            </small>
            @if (n.note) { <small class="note">“{{ n.note }}”</small> }
            @for (proof of n.proofs; track proof.id; let i = $index) {
              <a class="text-button" [href]="api.downloadUrl('/documents/' + proof.id + '/file')" target="_blank" rel="noopener noreferrer">
                View {{ proof.contentType === 'application/pdf' ? 'PDF' : 'screenshot' }}{{ n.proofs.length > 1 ? ' ' + (i + 1) : '' }}
              </a>
            }
          </div>
          @if (canReview()) {
            @if (rejecting() === n.id) {
              <form class="reject-form" (ngSubmit)="reject(n)">
                <label class="field"><span>Reason the tenant will see</span>
                  <input name="reason" [(ngModel)]="reason" required minlength="3" maxlength="300" placeholder="e.g. No matching transfer for this reference" /></label>
                <div class="modal-actions">
                  <button class="secondary" type="button" (click)="rejecting.set('')">Cancel</button>
                  <button class="primary" type="submit" [disabled]="busy() || reason.trim().length < 3">Send</button>
                </div>
              </form>
            } @else {
              <div class="actions">
                <button class="secondary" type="button" (click)="rejecting.set(n.id); reason = ''" [disabled]="busy()">Not received</button>
                <button class="primary" type="button" (click)="confirm(n)" [disabled]="busy()">Confirm</button>
              </div>
            }
          }
        </div>
      }
    </div>
    @if (nextCursor()) { <button class="secondary" type="button" (click)="load(true)" [disabled]="loading()">{{ loading() ? 'Loading…' : 'Load more reports' }}</button> }
  </section>
}`,
  styles: `
    .notices { margin-bottom: var(--space-6); border-color: var(--warning-border); }
    .notices h2 .status { margin-left: var(--space-2); vertical-align: middle; }
    .notice-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-3) var(--space-4);
      padding: var(--space-4) 0;
      border-top: 1px solid var(--border);
    }
    .notice-row:first-child { border-top: 0; }
    .notice-row strong, .notice-row small { display: block; }
    .notice-row small { margin-top: 2px; color: var(--text-muted); font-size: var(--text-sm); }
    .notice-row .note { font-style: italic; }
    .notice-row a.text-button { margin: var(--space-1) var(--space-2) 0 -10px; }
    .actions { display: flex; gap: var(--space-2); }
    .reject-form { grid-column: 1 / -1; }
    .reject-form .modal-actions { margin-top: 0; }
    @media (max-width: 640px) {
      .notice-row { grid-template-columns: 1fr; }
      .actions > * { flex: 1; }
    }
  `,
})
export class PaymentNoticesComponent implements OnInit {
  protected readonly api = inject(ApiClient);
  readonly changed = output<string>();
  protected readonly notices = signal<StaffPaymentNotice[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  private loadVersion = 0;
  protected readonly rejecting = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly canReview = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR'));
  protected reason = '';

  ngOnInit(): void {
    this.load();
  }

  load(more = false): void {
    if (more && (this.loading() || !this.nextCursor())) return;
    const version = ++this.loadVersion;
    const cursor = more ? this.nextCursor() : null;
    if (!more) this.nextCursor.set(null);
    this.loading.set(true);
    this.api.getList<StaffPaymentNotice>('/payment-notices', { cursor }).subscribe({
      next: (page) => {
        if (version !== this.loadVersion) return;
        this.notices.update(rows => more ? appendPage(rows, page.items) : page.items);
        this.nextCursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        if (version !== this.loadVersion) return;
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected confirm(n: StaffPaymentNotice): void {
    const details = `${n.tenantName}: ${n.amount} by ${n.method.replace('_', ' ').toLowerCase()}${n.referenceNumber ? ` (ref ${n.referenceNumber})` : ''}`;
    if (!confirm(`Record this payment and issue a receipt?\n\n${details}`)) return;
    this.review(this.api.post<{ payment?: { receiptNumber: string } }>(`/payment-notices/${n.id}/confirm`, {}), (result) =>
      `Payment from ${n.tenantName} recorded${result.payment ? ` — receipt ${result.payment.receiptNumber}` : ''}.`,
    );
  }

  protected reject(n: StaffPaymentNotice): void {
    this.review(this.api.post(`/payment-notices/${n.id}/reject`, { reason: this.reason.trim() }), () => `${n.tenantName} was told the payment was not received.`);
  }

  private review<T>(request: Observable<T>, message: (result: T) => string): void {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: (result) => {
        this.busy.set(false);
        this.rejecting.set('');
        this.changed.emit(message(result));
        this.load();
      },
      error: (error: ApiError) => {
        this.busy.set(false);
        this.error.set(error.message);
        this.load();
      },
    });
  }
}
