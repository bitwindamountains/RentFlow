import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { MoneyPipe } from '../core/format';
import type { TenantSummary } from '../core/models';
import { toCents } from '../core/money';

export interface TenantForm {
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

@Component({
  selector: 'app-tenants-page',
  imports: [FormsModule, RouterLink, MoneyPipe],
  template: `
<div class="page resource-page">
  <section class="page-heading">
    <div>
      <h1>Tenants</h1>
      <p>People, balances, and where they rent.</p>
    </div>
    @if (canManage()) { <button class="primary" type="button" (click)="open()">Add tenant</button> }
  </section>
  @if (error()) { <p class="inline-notice" role="alert">{{ error() }}</p> }

  @if (form(); as f) {
    <form #editor="ngForm" class="panel operations-form" (ngSubmit)="editor.valid && save()">
      <h2>{{ f.id ? 'Edit tenant' : 'Add tenant' }}</h2>
      <fieldset [disabled]="saving()">
        <div class="field-row">
          <label class="field"><span>First name</span><input name="first" [(ngModel)]="f.firstName" required maxlength="80" autocomplete="off" /></label>
          <label class="field"><span>Last name</span><input name="last" [(ngModel)]="f.lastName" required maxlength="80" autocomplete="off" /></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Email <em>Optional</em></span><input name="email" type="email" email [(ngModel)]="f.email" maxlength="254" /></label>
          <label class="field"><span>Mobile number <em>Optional</em></span><input name="phone" type="tel" [(ngModel)]="f.phone" pattern="[+0-9 ()-]{7,20}" placeholder="+63 917 123 4567" /></label>
        </div>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" [disabled]="saving()" (click)="form.set(null)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !editor.valid">{{ saving() ? 'Saving…' : 'Save tenant' }}</button>
      </div>
    </form>
  }

  <div class="resource-toolbar">
    <label class="field"><span>Search name, unit, or property</span><input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)" /></label>
    <label><input type="checkbox" [ngModel]="owingOnly()" (ngModelChange)="owingOnly.set($event)" /> Owing only</label>
    <label><input type="checkbox" [ngModel]="archived()" (ngModelChange)="archived.set($event); load()" /> Show archived</label>
  </div>
  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Tenant</th><th scope="col">Contact</th><th scope="col">Renting</th><th scope="col">Balance</th></tr></thead>
      <tbody>
        @for (t of visible(); track t.id) {
          <tr>
            <td><a [routerLink]="['/tenants', t.id]"><strong>{{ t.firstName }} {{ t.lastName }}</strong></a>
              @if (t.status === 'ARCHIVED') { <small>Archived</small> }</td>
            <td>
              @if (t.phone) { <a [href]="'tel:' + t.phone">{{ t.phone }}</a> } @else { <span>No phone</span> }
              <small>{{ t.email || 'No email' }}</small>
            </td>
            <td>
              @for (r of t.rentals; track r.leaseId) { <span>{{ r.propertyName }} · Unit {{ r.unitNumber }}</span> }
              @empty { <small>No active lease</small> }
            </td>
            <td [class.danger-text]="owes(t)">{{ t.balance | money }}</td>
          </tr>
        } @empty {
          <tr><td colspan="4" class="empty-cell">{{ loading() ? 'Loading tenants…' : 'No tenants found.' }}</td></tr>
        }
      </tbody>
    </table>
  </section>
</div>`,
})
export class TenantsPage implements OnInit {
  protected readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  protected readonly tenants = signal<TenantSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly query = signal('');
  protected readonly owingOnly = signal(false);
  protected readonly archived = signal(false);
  protected readonly form = signal<TenantForm | null>(null);
  protected readonly canManage = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.tenants().filter(
      (t) =>
        (!this.owingOnly() || this.owes(t)) &&
        `${t.firstName} ${t.lastName} ${t.phone ?? ''} ${t.rentals.map((r) => `${r.propertyName} ${r.unitNumber}`).join(' ')}`
          .toLowerCase()
          .includes(q),
    );
  });

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.api.get<TenantSummary[]>('/tenants', { includeArchived: this.archived() || undefined }).subscribe({
      next: (rows) => {
        this.tenants.set(rows);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected owes(t: TenantSummary): boolean {
    return toCents(t.balance) > 0;
  }

  protected open(): void {
    this.form.set({ firstName: '', lastName: '', email: '', phone: '' });
  }

  protected save(): void {
    const f = this.form();
    if (!f || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    const body = { firstName: f.firstName, lastName: f.lastName, email: f.email.trim() || undefined, phone: f.phone.trim() || undefined };
    this.api.post<TenantSummary>('/tenants', body).subscribe({
      next: (tenant) => {
        this.saving.set(false);
        this.form.set(null);
        void this.router.navigate(['/tenants', tenant.id]);
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }
}
