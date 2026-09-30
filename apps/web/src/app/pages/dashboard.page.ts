import { CurrencyPipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiClient } from '../core/api-client.service';

interface DashboardSummary {
  expected: string;
  collected: string;
  outstanding: string;
  activeLeases: number;
  occupiedUnits: number;
  totalUnits: number;
  collectionRate: number;
}

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, CurrencyPipe],
  templateUrl: './dashboard.page.html',
})
export class DashboardPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly reminders = signal<Array<{ id: string; type: string; title: string; detail: string; route: string; severity: string }>>([]);
  protected readonly topReminders = computed(() => this.reminders().slice(0, 3));
  protected readonly summary = signal<DashboardSummary>({ expected: '0', collected: '0', outstanding: '0', activeLeases: 0, occupiedUnits: 0, totalUnits: 0, collectionRate: 0 });
  protected readonly occupancyRate = computed(() => this.summary().totalUnits ? Math.round(this.summary().occupiedUnits / this.summary().totalUnits * 100) : 0);
  protected readonly organizationName = computed(() => this.api.profile()?.organization.name ?? 'Your rental business');

  ngOnInit(): void { this.refresh(); }
  constructor() { this.api.changes.pipe(takeUntilDestroyed()).subscribe(() => this.refresh()); }

  protected refresh(): void {
    this.loading.set(true);
    this.error.set('');
    forkJoin({ summary: this.api.get<DashboardSummary>('/dashboard'), reminders: this.api.get<any[]>('/reminders') }).subscribe({
      next: ({ summary, reminders }) => { this.summary.set(summary); this.reminders.set(reminders); this.loading.set(false); },
      error: () => { this.error.set('We could not load your dashboard. Please try again.'); this.loading.set(false); },
    });
  }
}
