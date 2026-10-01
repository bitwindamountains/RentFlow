import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiClient, type ApiError, isUncertain } from '../core/api-client.service';
import { DayPipe, LabelPipe, MomentPipe, MoneyPipe } from '../core/format';
import type { PaymentNotice, PortalHome, PortalPayment } from '../core/models';
import { isMoney } from '../core/money';

const PROOF_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

@Component({
  selector: 'app-portal-payments-page',
  imports: [FormsModule, RouterLink, MoneyPipe, DayPipe, MomentPipe, LabelPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div>
      <p class="eyebrow">{{ home()?.organization?.name }}</p>
      <h1>Payments</h1>
      <p>Paid by GCash, Maya, or bank transfer? Report it here and your landlord confirms it and issues a receipt.</p>
    </div>
    @if (!formOpen()) { <button class="primary" type="button" (click)="openForm()">Report a payment</button> }
  </section>
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && submit()">
      <h2>Report a payment</h2>
      <fieldset [disabled]="saving()">
        @if (leases().length > 1) {
          <label class="field"><span>Rental</span>
            <select name="lease" [(ngModel)]="draft.leaseId" required>
              @for (l of leases(); track l.id) { <option [value]="l.id">{{ l.propertyName }} · Unit {{ l.unitNumber }}</option> }
            </select></label>
        }
        <div class="field-row">
          <label class="field"><span>Amount paid</span>
            <div class="money-input"><b>{{ home()?.organization?.currency }}</b><input name="amount" [(ngModel)]="draft.amount" required inputmode="decimal" autocomplete="off" pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" /></div></label>
          <label class="field"><span>How you paid</span>
            <select name="method" [(ngModel)]="draft.method">
              <option value="GCASH">GCash</option><option value="MAYA">Maya</option><option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CASH">Cash</option><option value="CHEQUE">Cheque</option><option value="OTHER">Other</option>
            </select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Reference no. @if (draft.method === 'CASH') { <em>Optional</em> }</span>
            <input name="reference" [(ngModel)]="draft.referenceNumber" maxlength="100" [required]="needsReference()" placeholder="e.g. 7845 120 369" /></label>
          <label class="field"><span>Date paid</span>
            <input name="paidOn" type="date" [(ngModel)]="draft.paidOn" [max]="today()" required /></label>
        </div>
        <label class="field"><span>Screenshot or receipt <em>Optional · JPEG, PNG, WebP, or PDF up to 10 MB</em></span>
          <input name="proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" (change)="pick($event)" /></label>
        <label class="field"><span>Note <em>Optional</em></span>
          <textarea name="note" [(ngModel)]="draft.note" maxlength="500" placeholder="e.g. Paid for October rent and water"></textarea></label>
        <small>This doesn’t record the payment yet. Your landlord checks it, then you get a receipt.</small>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="closeForm()" [disabled]="saving()">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid">{{ saving() ? 'Sending…' : 'Send report' }}</button>
      </div>
    </form>
  }

  @if (notices().length) {
    <h2>Your reports</h2>
    <section class="panel">
      <div class="attention-list">
        @for (n of notices(); track n.id) {
          <div class="attention-item">
            <span [class]="'attention-icon ' + tone(n.status)" aria-hidden="true">{{ n.status === 'CONFIRMED' ? '✓' : n.status === 'REJECTED' ? '!' : '…' }}</span>
            <span>
              <strong>{{ n.amount | money }} · {{ n.method | label }}{{ n.referenceNumber ? ' · ' + n.referenceNumber : '' }}</strong>
              <small>
                Paid {{ n.paidOn | day }} · {{ statusText(n) }}
                @if (n.rejectionReason) { — {{ n.rejectionReason }} }
              </small>
            </span>
            @if (n.status === 'CONFIRMED' && n.paymentId) {
              <a class="text-button" [routerLink]="['/portal/receipts', n.paymentId]">Receipt {{ n.receiptNumber }}</a>
            } @else if (n.status === 'SUBMITTED') {
              <button class="text-button" type="button" (click)="withdraw(n)">Withdraw</button>
            }
          </div>
        }
      </div>
    </section>
  }

  <h2>Payment history</h2>
  <section class="panel">
    <div class="attention-list">
      @for (p of payments(); track p.id) {
        <a class="attention-item" [routerLink]="['/portal/receipts', p.id]">
          <span [class]="'attention-icon ' + (p.status === 'POSTED' ? 'green' : 'red')" aria-hidden="true">{{ p.status === 'POSTED' ? '✓' : '×' }}</span>
          <span>
            <strong>{{ p.amount | money }}@if (p.status !== 'POSTED') { · reversed }</strong>
            <small>{{ p.paidAt | moment: 'date' }} · {{ p.method | label }}{{ p.referenceNumber ? ' · ' + p.referenceNumber : '' }}</small>
          </span>
          <span class="text-button">{{ p.receiptNumber ?? 'Receipt' }} &rsaquo;</span>
        </a>
      } @empty {
        <p class="empty-cell">{{ loading() ? 'Loading…' : 'No payments recorded yet.' }}</p>
      }
    </div>
  </section>
</div>`,
})
export class PortalPaymentsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);
  protected readonly home = signal<PortalHome | null>(null);
  protected readonly payments = signal<PortalPayment[]>([]);
  protected readonly notices = signal<PaymentNotice[]>([]);
  protected readonly leases = computed(() => (this.home()?.leases ?? []).filter((l) => l.status === 'ACTIVE'));
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly today = () => this.api.today();
  protected draft = this.emptyDraft();
  private proof: File | null = null;
  /** One key per report: a retry after a dropped connection never files it twice. */
  private key = crypto.randomUUID();

  ngOnInit(): void {
    this.load(() => {
      if (this.route.snapshot.queryParamMap.get('report')) this.openForm();
    });
  }

  private load(then?: () => void): void {
    forkJoin({
      home: this.api.get<PortalHome>('/portal/home'),
      history: this.api.get<{ payments: PortalPayment[]; notices: PaymentNotice[] }>('/portal/payments'),
    }).subscribe({
      next: ({ home, history }) => {
        this.home.set(home);
        this.payments.set(history.payments);
        this.notices.set(history.notices);
        this.loading.set(false);
        then?.();
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected openForm(): void {
    const home = this.home();
    this.draft = this.emptyDraft();
    this.draft.leaseId = this.leases()[0]?.id ?? home?.leases[0]?.id ?? '';
    const due = home?.balance.outstanding;
    if (due && due !== '0.00') this.draft.amount = due;
    this.proof = null;
    this.key = crypto.randomUUID();
    this.notice.set('');
    this.formOpen.set(true);
  }

  protected closeForm(): void {
    this.formOpen.set(false);
  }

  protected needsReference(): boolean {
    return ['GCASH', 'MAYA', 'BANK_TRANSFER'].includes(this.draft.method);
  }

  protected pick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.error.set('');
    if (file && (!PROOF_TYPES.includes(file.type) || file.size > 10 * 1_048_576)) {
      this.error.set('Attach a JPEG, PNG, WebP, or PDF up to 10 MB. On an iPhone, share the screenshot as JPEG.');
      input.value = '';
      this.proof = null;
      return;
    }
    this.proof = file;
  }

  protected submit(): void {
    if (!isMoney(this.draft.amount)) {
      this.error.set('Enter the amount you paid, for example 8500 or 8500.50.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    const body = {
      leaseId: this.draft.leaseId,
      amount: this.draft.amount,
      method: this.draft.method,
      referenceNumber: this.draft.referenceNumber.trim() || undefined,
      paidOn: this.draft.paidOn,
      note: this.draft.note.trim() || undefined,
    };
    this.api.post<PaymentNotice>('/portal/payment-notices', body, this.key).subscribe({
      next: (created) => {
        const done = (message: string) => {
          this.saving.set(false);
          this.formOpen.set(false);
          this.notice.set(message);
          this.load();
        };
        if (!this.proof) return done('Sent. Your landlord will confirm it and issue a receipt.');
        this.api.upload(`/portal/payment-notices/${created.id}/proof`, this.proof).subscribe({
          next: () => done('Sent with your screenshot. Your landlord will confirm it and issue a receipt.'),
          error: (error: ApiError) => done(`Your report was sent, but the attachment did not upload: ${error.message}`),
        });
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(
          isUncertain(error)
            ? 'We could not confirm your report was sent. Press Send report again — it will not be sent twice.'
            : error.message,
        );
      },
    });
  }

  protected withdraw(n: PaymentNotice): void {
    if (!confirm('Withdraw this payment report?')) return;
    this.api.post(`/portal/payment-notices/${n.id}/withdraw`, {}).subscribe({
      next: () => {
        this.notice.set('Report withdrawn.');
        this.load();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected tone(status: string): string {
    return status === 'CONFIRMED' ? 'green' : status === 'REJECTED' ? 'red' : status === 'SUBMITTED' ? 'orange' : 'blue';
  }

  protected statusText(n: PaymentNotice): string {
    switch (n.status) {
      case 'SUBMITTED':
        return 'waiting for confirmation';
      case 'CONFIRMED':
        return 'confirmed';
      case 'REJECTED':
        return 'not confirmed';
      default:
        return 'withdrawn';
    }
  }

  private emptyDraft() {
    return { leaseId: '', amount: '', method: 'GCASH', referenceNumber: '', paidOn: this.api.today(), note: '' };
  }
}
