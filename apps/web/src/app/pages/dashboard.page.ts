import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, MoneyPipe } from '../core/format';
import type { Dashboard, Reminder } from '../core/models';
import { toCents } from '../core/money';
import { PaymentLauncher } from '../core/payment-launcher.service';

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, MoneyPipe, DayPipe],
  templateUrl: './dashboard.page.html',
})
export class DashboardPage implements OnInit {
  protected readonly api = inject(ApiClient);
  private readonly payments = inject(PaymentLauncher);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly data = signal<Dashboard | null>(null);
  protected readonly reminders = signal<Reminder[]>([]);
  protected readonly otherReminders = computed(() =>
    this.reminders()
      .filter((item) => item.type !== 'OVERDUE_BALANCE')
      .slice(0, 4),
  );
  protected readonly organizationName = computed(() => this.api.profile()?.organization.name ?? 'Your rental business');
  protected readonly chartMax = computed(() =>
    Math.max(1, ...(this.data()?.trend ?? []).flatMap((m) => [toCents(m.billed), toCents(m.collected)])),
  );

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

  protected monthLabel(month: string): string {
    return new Intl.DateTimeFormat('en-PH', { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  }

  protected collect(leaseId: string): void {
    this.payments.open(leaseId);
  }

  protected canCollect(): boolean {
    return this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR');
  }
}
