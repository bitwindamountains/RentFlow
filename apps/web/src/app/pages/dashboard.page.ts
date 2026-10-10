import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { CountUpDirective } from '../core/count-up.directive';
import { DayPipe, MoneyPipe } from '../core/format';
import type { Dashboard, Reminder } from '../core/models';
import { toCents } from '../core/money';
import { PaymentLauncher } from '../core/payment-launcher.service';

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, MoneyPipe, DayPipe, CountUpDirective],
  templateUrl: './dashboard.page.html',
})
export class DashboardPage implements OnInit {
  protected readonly api = inject(ApiClient);
  private readonly payments = inject(PaymentLauncher);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly data = signal<Dashboard | null>(null);
  protected readonly reminders = signal<Reminder[]>([]);
  protected readonly showTable = signal(false);
  protected readonly skeletonAreas = ['hero', 'overdue', 'billed', 'occupancy', 'arrears', 'trend', 'upcoming'];
  protected readonly otherReminders = computed(() =>
    this.reminders()
      .filter((item) => item.type !== 'OVERDUE_BALANCE')
      .slice(0, 4),
  );
  /** Top of the y-axis in centavos, rounded up to a clean tick (1, 2, 2.5 or 5 × 10ⁿ pesos). */
  protected readonly chartMax = computed(() => {
    const peak = Math.max(1, ...(this.data()?.trend ?? []).flatMap((m) => [toCents(m.billed), toCents(m.collected)])) / 100;
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    const step = [1, 2, 2.5, 5, 10].find((f) => f * magnitude >= peak) ?? 10;
    return step * magnitude * 100;
  });

  /** Smoothed six-month "collected" line for the hero tile (viewBox 0 0 100 40). Decorative; the chart below has the numbers. */
  protected readonly spark = computed(() => {
    const values = (this.data()?.trend ?? []).map((m) => toCents(m.collected));
    if (values.length < 2) return null;
    const max = Math.max(1, ...values);
    const points = values.map((v, i) => [(i / (values.length - 1)) * 100, 36 - (v / max) * 30]);
    const at = ([x, y]: number[]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
    const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let line = `M${at(points[0])} L${at(mid(points[0], points[1]))}`;
    for (let i = 1; i < points.length - 1; i++) line += ` Q${at(points[i])} ${at(mid(points[i], points[i + 1]))}`;
    line += ` L${at(points[points.length - 1])}`;
    return { line, area: `${line} L100 40 L0 40 Z` };
  });

  constructor() {
    this.api.changes.pipe(takeUntilDestroyed()).subscribe(() => this.refresh());
  }

  ngOnInit(): void {
    this.refresh();
  }

  protected refresh(): void {
    this.loading.set(true);
    this.error.set('');
    forkJoin({
      summary: this.api.get<Dashboard>('/dashboard'),
      reminders: this.api.get<Reminder[]>('/reminders'),
    }).subscribe({
      next: ({ summary, reminders }) => {
        this.data.set(summary);
        this.reminders.set(reminders);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected barHeight(value: string): number {
    return Math.round((toCents(value) / this.chartMax()) * 100);
  }

  protected monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
    const options: Intl.DateTimeFormatOptions =
      style === 'long' ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' };
    return new Intl.DateTimeFormat('en-PH', options).format(new Date(`${month}-01T00:00:00Z`));
  }

  protected axisLabel(cents: number): string {
    const currency = this.data()?.currency ?? 'PHP';
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
  }

  protected collectionLabel(d: Dashboard): string {
    return d.collectionRate === null
      ? 'Nothing billed yet this month'
      : `${d.collectionRate}% of the ${new Intl.NumberFormat('en-PH', { style: 'currency', currency: d.currency }).format(Number(d.billedThisMonth))} billed this month has been collected`;
  }

  protected collect(leaseId: string): void {
    this.payments.open(leaseId);
  }

  protected canCollect(): boolean {
    return this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR');
  }
}
