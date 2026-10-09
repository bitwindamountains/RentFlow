import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, LabelPipe, MomentPipe, MoneyPipe } from '../core/format';
import type { PortalHome } from '../core/models';

@Component({
  selector: 'app-portal-home-page',
  imports: [RouterLink, MoneyPipe, DayPipe, MomentPipe, LabelPipe],
  template: `
<div class="page portal">
  @if (error()) {
    <div class="inline-notice" role="alert">{{ error() }} <button class="text-button" type="button" (click)="load()">Try again</button></div>
  }
  @if (home(); as h) {
    <section class="page-heading">
      <div>
        <p class="eyebrow">{{ h.organization.name }}</p>
        <h1>Hi, {{ h.tenant.firstName }}</h1>
        <p>Your rent, receipts, and repairs in one place.</p>
      </div>
    </section>

    <section class="portal-grid" aria-label="Your rental">
      <article class="tile tile-hero portal-balance" [class.is-clear]="!owes()">
        @if (owes()) {
          <p class="tile-label">Amount due</p>
          <strong class="tile-value">{{ h.balance.outstanding | money }}</strong>
          @if (h.balance.overdue !== '0.00') {
            <p class="status danger">{{ h.balance.overdue | money }} is past due</p>
          } @else if (h.balance.nextDue; as next) {
            <p class="tile-note">Next due {{ next.date | day }} · {{ next.amount | money }}</p>
          }
        } @else {
          <p class="tile-label">You’re all paid up</p>
          <strong class="tile-value">{{ 0 | money }}</strong>
          <p class="tile-note">
            @if (h.balance.credit !== '0.00') { You have {{ h.balance.credit | money }} credit for future rent. } @else { Nothing is due right now. }
          </p>
        }
        @if (pending().length) {
          <p class="pending-note" role="status">
            {{ pending().length === 1 ? 'A payment report is' : pending().length + ' payment reports are' }} waiting for {{ h.organization.name }} to confirm.
          </p>
        }
        <div class="tile-foot portal-actions">
          <a class="primary button-link" routerLink="/portal/payments" [queryParams]="{ report: 1 }">I’ve paid — let them know</a>
          <a class="secondary button-link" routerLink="/portal/payments">Payment history</a>
        </div>
      </article>

      <article class="tile portal-charges">
        <div class="panel-title"><div><h2>What you owe</h2><p>Oldest first. Payments are applied to the oldest charge.</p></div></div>
        <div class="attention-list">
          @for (c of h.openCharges; track c.id) {
            <div class="attention-item">
              <span [class]="'attention-icon ' + (c.overdue ? 'red' : 'blue')" [attr.data-icon]="c.overdue ? 'alert' : 'receipt'" aria-hidden="true"></span>
              <span>
                <strong>{{ c.description }}{{ c.billingPeriod ? ' · ' + c.billingPeriod : '' }}</strong>
                <small>Due {{ c.dueDate | day }}@if (c.outstanding !== c.amount) { · {{ c.amount | money }} billed }</small>
              </span>
              <span class="charge-amount">
                <strong>{{ c.outstanding | money }}</strong>
                @if (c.overdue) { <span class="status danger">Past due</span> }
              </span>
            </div>
          } @empty {
            <div class="attention-item">
              <span class="attention-icon green" data-icon="check" aria-hidden="true"></span>
              <span><strong>No open charges</strong><small>New rent appears here when it is billed.</small></span>
            </div>
          }
        </div>
      </article>

      @for (lease of h.leases; track lease.id) {
        <article class="tile portal-lease">
          <p class="tile-label">{{ lease.status === 'ACTIVE' ? 'Your rental' : 'Previous rental' }}</p>
          <h2>{{ lease.propertyName }} · Unit {{ lease.unitNumber }}</h2>
          <p class="tile-note">{{ lease.address }}</p>
          <dl class="lease-facts">
            <div><dt>Monthly rent</dt><dd>{{ lease.monthlyRent | money }}</dd></div>
            <div><dt>Due</dt><dd>{{ ordinal(lease.dueDay) }} of the month</dd></div>
            <div><dt>Lease</dt><dd>{{ lease.startDate | day }} – {{ lease.endDate ? (lease.endDate | day) : 'month to month' }}</dd></div>
            @if (lease.depositHeld) { <div><dt>Deposit held</dt><dd>{{ lease.depositHeld | money }}</dd></div> }
          </dl>
        </article>
      }

      <article class="tile portal-payments">
        <div class="panel-title">
          <div><h2>Recent payments</h2><p>Open a receipt to print or save it.</p></div>
          <a class="text-button" routerLink="/portal/payments">All &rarr;</a>
        </div>
        <div class="attention-list">
          @for (p of h.recentPayments; track p.id) {
            <a class="attention-item" [routerLink]="['/portal/receipts', p.id]">
              <span class="attention-icon green" data-icon="check" aria-hidden="true"></span>
              <span><strong>{{ p.amount | money }}</strong><small>{{ p.paidAt | moment: 'date' }} · {{ p.method | label }}@if (p.status === 'REVERSED') { · reversed }</small></span>
              <span class="text-button">{{ p.receiptNumber ?? 'Receipt' }} &rsaquo;</span>
            </a>
          } @empty {
            <p class="empty-cell">No payments recorded yet.</p>
          }
        </div>
      </article>

      <a class="tile portal-repairs" routerLink="/portal/repairs">
        <p class="tile-label">Something broken?</p>
        <strong class="repairs-title">Report a repair</strong>
        <p class="tile-note">Tell {{ h.organization.name }} what needs fixing and follow its progress.</p>
      </a>
    </section>
  } @else if (loading()) {
    <section class="portal-grid" aria-busy="true">
      <div class="tile tile-hero is-skeleton"><span class="skeleton" style="width: 30%; height: 14px"></span><span class="skeleton" style="width: 60%; height: 40px"></span></div>
      <div class="tile is-skeleton"><span class="skeleton" style="width: 50%; height: 14px"></span><span class="skeleton" style="width: 80%; height: 14px"></span></div>
      <p class="sr-only" role="status">Loading your rental…</p>
    </section>
  }
</div>`,
  styles: `
    .portal-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-4);
    }
    /* Reuses the dashboard hero look, but not its bento grid-area. */
    .portal-balance { grid-area: auto; grid-column: 1 / -1; }
    .portal-balance.is-clear .tile-value { color: var(--success-fg); }
    .portal-balance .status { align-self: flex-start; margin-top: var(--space-3); font-size: var(--text-sm); }
    .pending-note {
      margin: var(--space-4) 0 0;
      padding: 10px 14px;
      border-radius: var(--radius-md);
      background: var(--warning-bg);
      color: var(--warning-fg);
      font-size: var(--text-sm);
    }
    .portal-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
    .charge-amount { display: grid; justify-items: end; gap: 4px; text-align: right; }
    .portal-lease h2 { margin-top: var(--space-2); font-size: var(--text-lg); }
    .lease-facts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
      margin: var(--space-4) 0 0;
    }
    .lease-facts div { padding: var(--space-3); border-radius: var(--radius-md); background: var(--surface-2); }
    .lease-facts dt { color: var(--text-muted); font-size: var(--text-xs); }
    .lease-facts dd { margin: 2px 0 0; font-weight: 650; }
    .repairs-title { display: block; margin-top: var(--space-2); font-size: var(--text-xl); }
    .attention-list .empty-cell { padding: var(--space-6); border: 0; }
    @media (max-width: 760px) {
      .portal-grid { grid-template-columns: 1fr; }
      .portal-actions > * { flex: 1; }
    }
  `,
})
export class PortalHomePage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly home = signal<PortalHome | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly owes = computed(() => (this.home()?.balance.outstanding ?? '0.00') !== '0.00');
  protected readonly pending = computed(() => (this.home()?.notices ?? []).filter((n) => n.status === 'SUBMITTED'));

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.get<PortalHome>('/portal/home').subscribe({
      next: (home) => {
        this.home.set(home);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected ordinal(day: number): string {
    const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${day}${suffix}`;
  }
}
