import { Component, type OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { LabelPipe, MomentPipe, MoneyPipe } from '../core/format';
import type { Receipt } from '../core/models';

@Component({
  selector: 'app-receipt-page',
  imports: [RouterLink, MoneyPipe, MomentPipe, LabelPipe],
  styles: `
    .receipt { max-width: 640px; margin: 0 auto; }
    .receipt dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
    .receipt dt { color: #5d6661; }
    .receipt table { width: 100%; min-width: 0; table-layout: fixed; }
    .receipt .total { font-size: 1.25rem; }
    .voided { border: 2px solid #b42318; color: #b42318; padding: 8px 12px; border-radius: 8px; font-weight: 700; }
    @media print {
      .no-print { display: none !important; }
      .receipt { box-shadow: none; border: 0; }
    }
  `,
  template: `
<div class="page">
  <p class="no-print"><a routerLink="/payments" class="text-button">&larr; Payments</a></p>
  @if (error()) { <p class="inline-notice" role="alert">{{ error() }}</p> }
  @if (receipt(); as r) {
    <article class="panel receipt" aria-labelledby="receipt-title">
      <p class="eyebrow">{{ r.organization.name }}</p>
      <h1 id="receipt-title">Acknowledgement receipt {{ r.receiptNumber }}</h1>
      <p><small>Proof of payment for your records. Not a BIR official receipt.</small></p>
      @if (r.voided) { <p class="voided" role="status">VOID — {{ r.voidReason ?? 'Payment reversed' }}</p> }
      <dl>
        <dt>Received from</dt><dd>{{ r.tenantName }}</dd>
        @if (r.property) { <dt>Property</dt><dd>{{ r.property.name }}, Unit {{ r.property.unit }}<br /><small>{{ r.property.address }}</small></dd> }
        <dt>Date paid</dt><dd>{{ r.paidAt | moment }}</dd>
        <dt>Method</dt><dd>{{ r.method | label }}{{ r.referenceNumber ? ' · Ref ' + r.referenceNumber : '' }}</dd>
        <dt>Issued</dt><dd>{{ r.issuedAt | moment }}</dd>
      </dl>
      <table>
        <caption class="sr-only">Amounts applied</caption>
        <thead><tr><th scope="col">Applied to</th><th scope="col">Amount</th></tr></thead>
        <tbody>
          @for (line of r.lines; track $index) { <tr><td>{{ line.description }}{{ line.billingPeriod ? ' (' + line.billingPeriod + ')' : '' }}</td><td>{{ line.amount | money }}</td></tr> }
          @if (r.credit !== '0.00') { <tr><td>Advance / credit on account</td><td>{{ r.credit | money }}</td></tr> }
        </tbody>
        <tfoot><tr><th scope="row">Total received</th><td class="total"><strong>{{ r.amount | money }}</strong></td></tr></tfoot>
      </table>
      <div class="modal-actions no-print">
        <button class="secondary" type="button" (click)="share(r)">Share</button>
        <button class="primary" type="button" (click)="print()">Print or save PDF</button>
      </div>
    </article>
  } @else if (!error()) {
    <p role="status">Loading receipt…</p>
  }
</div>`,
})
export class ReceiptPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id')!;
  protected readonly receipt = signal<Receipt | null>(null);
  protected readonly error = signal('');

  ngOnInit(): void {
    this.api.get<Receipt>(`/payments/${this.id}/receipt`).subscribe({
      next: (receipt) => this.receipt.set(receipt),
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected print(): void {
    window.print();
  }

  protected async share(receipt: Receipt): Promise<void> {
    const text = `${receipt.organization.name} — Receipt ${receipt.receiptNumber}: ${receipt.organization.currency} ${receipt.amount} received from ${receipt.tenantName} on ${new Date(receipt.paidAt).toLocaleDateString('en-PH')}.`;
    if (navigator.share) await navigator.share({ title: `Receipt ${receipt.receiptNumber}`, text }).catch(() => undefined);
    else await navigator.clipboard?.writeText(text).catch(() => undefined);
  }
}
