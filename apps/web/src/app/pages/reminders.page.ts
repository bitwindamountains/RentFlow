import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import type { Reminder } from '../core/models';
import { PaymentLauncher } from '../core/payment-launcher.service';

@Component({
  selector: 'app-reminders-page',
  imports: [RouterLink],
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
</div>`,
})
export class RemindersPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly payments = inject(PaymentLauncher);
  protected readonly reminders = signal<Reminder[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly canCollect = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR'));

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
  }
}
