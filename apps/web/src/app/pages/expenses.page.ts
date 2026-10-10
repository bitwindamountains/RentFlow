import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, LabelPipe, MoneyPipe } from '../core/format';
import type { Page, Property } from '../core/models';

interface Expense {
  id: string;
  propertyName: string | null;
  category: string;
  description: string;
  vendor: string | null;
  amount: string;
  incurredOn: string;
  reference: string | null;
  voided: boolean;
  voidReason: string | null;
}

@Component({
  selector: 'app-expenses-page',
  imports: [FormsModule, MoneyPipe, DayPipe, LabelPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><h1>Expenses</h1><p>Property costs and vendors, for per-property profit and loss.</p></div>
    @if (canWrite()) { <button class="primary" type="button" (click)="open()">Add expense</button> }
  </section>
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && save()">
      <fieldset [disabled]="saving()">
        <div class="field-row">
          <label class="field"><span>Category</span>
            <select name="category" [(ngModel)]="draft.category">
              @for (c of categories; track c) { <option [value]="c">{{ c | label }}</option> }
            </select></label>
          <label class="field"><span>Property</span>
            <select name="property" [(ngModel)]="draft.propertyId">
              <option value="">General business</option>
              @for (p of properties(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select></label>
        </div>
        <label class="field"><span>Description</span><input name="description" [(ngModel)]="draft.description" required minlength="2" maxlength="180" /></label>
        <div class="field-row">
          <label class="field"><span>Amount</span><input name="amount" [(ngModel)]="draft.amount" required pattern="[0-9]{1,13}(\\.[0-9]{1,2})?" inputmode="decimal" /></label>
          <label class="field"><span>Date</span><input name="date" type="date" [(ngModel)]="draft.incurredOn" required /></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Vendor <em>Optional</em></span><input name="vendor" [(ngModel)]="draft.vendor" maxlength="120" /></label>
          <label class="field"><span>OR / invoice no. <em>Optional</em></span><input name="reference" [(ngModel)]="draft.reference" maxlength="100" /></label>
        </div>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="formOpen.set(false)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid">Save</button>
      </div>
    </form>
  }

  <label class="resource-toolbar"><input type="checkbox" [ngModel]="showVoided()" (ngModelChange)="showVoided.set($event); load()" /> Show voided</label>
  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Expense</th><th scope="col">Category</th><th scope="col">Amount</th><th scope="col">Date</th><th scope="col"></th></tr></thead>
      <tbody>
        @for (e of expenses(); track e.id) {
          <tr [class.warning-text]="e.voided">
            <td><strong>{{ e.description }}</strong><small>{{ e.propertyName ?? 'General' }}{{ e.vendor ? ' · ' + e.vendor : '' }}{{ e.reference ? ' · ' + e.reference : '' }}</small></td>
            <td>{{ e.category | label }}</td>
            <td>{{ e.amount | money }}@if (e.voided) { <small>Voided: {{ e.voidReason }}</small> }</td>
            <td>{{ e.incurredOn | day }}</td>
            <td>@if (canWrite() && !e.voided) { <button class="text-button" type="button" (click)="voidExpense(e)">Void</button> }</td>
          </tr>
        } @empty { <tr><td colspan="5" class="empty-cell">{{ loading() ? 'Loading…' : 'No expenses yet.' }}</td></tr> }
      </tbody>
    </table>
  </section>
  @if (nextCursor()) { <button class="secondary" type="button" (click)="load(nextCursor()!)">Load more</button> }
</div>`,
})
export class ExpensesPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly categories = ['REPAIR', 'UTILITIES', 'TAX', 'INSURANCE', 'SUPPLIES', 'MANAGEMENT', 'OTHER'];
  protected readonly expenses = signal<Expense[]>([]);
  protected readonly properties = signal<Property[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly showVoided = signal(false);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly canWrite = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected draft = this.blank();

  ngOnInit(): void {
    this.load();
    this.api.get<Property[]>('/properties').subscribe((rows) => this.properties.set(rows));
  }

  private blank() {
    return { category: 'REPAIR', propertyId: '', description: '', amount: '', incurredOn: this.api.today(), vendor: '', reference: '' };
  }

  protected load(cursor?: string): void {
    this.loading.set(true);
    this.api.get<Page<Expense>>('/expenses', { cursor, limit: 50, includeVoided: this.showVoided() || undefined }).subscribe({
      next: (page) => {
        this.expenses.set(cursor ? [...this.expenses(), ...page.items] : page.items);
        this.nextCursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected open(): void {
    this.draft = this.blank();
    this.formOpen.set(true);
  }

  protected save(): void {
    this.saving.set(true);
    this.error.set('');
    this.api.post('/expenses', { ...this.draft, propertyId: this.draft.propertyId || undefined }).subscribe({
      next: () => {
        this.saving.set(false);
        this.formOpen.set(false);
        this.notice.set('Expense saved.');
        this.load();
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected voidExpense(expense: Expense): void {
    const reason = prompt(`Why void "${expense.description}"? It stays in history but is excluded from reports.`);
    if (!reason || reason.trim().length < 3) return;
    this.api.post(`/expenses/${expense.id}/void`, { reason: reason.trim() }).subscribe({
      next: () => {
        this.notice.set('Expense voided.');
        this.load();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }
}
