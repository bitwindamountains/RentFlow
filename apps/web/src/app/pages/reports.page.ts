import { Component, type OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, MoneyPipe } from '../core/format';

interface FinancialReport {
  from: string;
  to: string;
  billed: string;
  adjustments: string;
  collected: string;
  expenses: string;
  netCash: string;
  chargeCount: number;
  paymentCount: number;
  expenseCount: number;
  properties: Array<{ propertyId: string; name: string; collected: string; expenses: string; net: string }>;
}

@Component({
  selector: 'app-reports-page',
  imports: [FormsModule, MoneyPipe, DayPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><h1>Reports</h1><p>Income, expenses, and profit per property for any period.</p></div>
  </section>
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }
  <form class="resource-toolbar" (ngSubmit)="load()">
    <label class="field"><span>From</span><input name="from" type="date" [(ngModel)]="from" required /></label>
    <label class="field"><span>To</span><input name="to" type="date" [(ngModel)]="to" [min]="from" required /></label>
    <button class="secondary" type="submit">Update</button>
    <div role="group" aria-label="Quick ranges">
      <button class="filter-button" type="button" (click)="preset('month')">This month</button>
      <button class="filter-button" type="button" (click)="preset('lastMonth')">Last month</button>
      <button class="filter-button" type="button" (click)="preset('year')">This year</button>
    </div>
  </form>
  @if (report(); as r) {
    <p>{{ r.from | day }} to {{ r.to | day }}</p>
    <section class="metric-grid">
      <article class="metric-card"><p>Billed (net of adjustments)</p><strong>{{ r.billed | money }}</strong><small>{{ r.chargeCount }} charges · {{ r.adjustments | money }} adjusted</small></article>
      <article class="metric-card"><p>Collected</p><strong>{{ r.collected | money }}</strong><small>{{ r.paymentCount }} payments</small></article>
      <article class="metric-card"><p>Expenses</p><strong>{{ r.expenses | money }}</strong><small>{{ r.expenseCount }} expenses</small></article>
      <article class="metric-card"><p>Net cash</p><strong [class.danger-text]="r.netCash.startsWith('-')">{{ r.netCash | money }}</strong><small>Collected less expenses</small></article>
    </section>
    <h2>By property</h2>
    <section class="data-panel table-wrap">
      <table>
        <thead><tr><th scope="col">Property</th><th scope="col">Collected</th><th scope="col">Expenses</th><th scope="col">Net</th></tr></thead>
        <tbody>
          @for (p of r.properties; track p.propertyId) {
            <tr><td>{{ p.name }}</td><td>{{ p.collected | money }}</td><td>{{ p.expenses | money }}</td><td [class.danger-text]="p.net.startsWith('-')">{{ p.net | money }}</td></tr>
          } @empty { <tr><td colspan="4" class="empty-cell">No properties yet.</td></tr> }
        </tbody>
      </table>
    </section>
    <a class="primary button-link export-link" [href]="csvUrl()" download>Download transactions (CSV)</a>
  } @else if (!error()) {
    <p role="status">Loading report…</p>
  }
</div>`,
})
export class ReportsPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly report = signal<FinancialReport | null>(null);
  protected readonly error = signal('');
  protected from = `${this.api.today().slice(0, 4)}-01-01`;
  protected to = this.api.today();

  ngOnInit(): void {
    this.load();
  }

  protected preset(kind: 'month' | 'lastMonth' | 'year'): void {
    const today = this.api.today();
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7)) - 1;
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (kind === 'month') {
      this.from = `${today.slice(0, 7)}-01`;
      this.to = today;
    } else if (kind === 'lastMonth') {
      this.from = iso(new Date(Date.UTC(year, month - 1, 1)));
      this.to = iso(new Date(Date.UTC(year, month, 0)));
    } else {
      this.from = `${year}-01-01`;
      this.to = today;
    }
    this.load();
  }

  protected load(): void {
    this.error.set('');
    this.api.get<FinancialReport>('/reports/financial', { from: this.from, to: this.to }).subscribe({
      next: (row) => this.report.set(row),
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected csvUrl(): string {
    return this.api.downloadUrl('/reports/transactions.csv', { from: this.from, to: this.to });
  }
}
