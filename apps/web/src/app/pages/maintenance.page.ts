import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { appendPage } from '../core/pagination';
import { FormsModule } from '@angular/forms';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { DayPipe, LabelPipe, MomentPipe, statusTone } from '../core/format';

interface WorkOrder {
  id: string;
  propertyId: string;
  propertyName: string;
  unitNumber: string | null;
  title: string;
  description: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  assignedTo: string | null;
  dueOn: string | null;
  completedAt: string | null;
  createdAt: string;
}
interface PropertyOption {
  id: string;
  name: string;
  units: Array<{ id: string; number: string }>;
}

@Component({
  selector: 'app-maintenance-page',
  imports: [FormsModule, DayPipe, MomentPipe, LabelPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><h1>Maintenance</h1><p>Repairs and work orders, most urgent first.</p></div>
    @if (canWrite()) { <button class="primary" type="button" (click)="open()">New work order</button> }
  </section>
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && save()">
      <fieldset [disabled]="saving()">
        <div class="field-row">
          <label class="field"><span>Property</span>
            <select name="property" [(ngModel)]="draft.propertyId" (ngModelChange)="draft.unitId = ''" required>
              @for (p of properties(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select></label>
          <label class="field"><span>Unit <em>Optional</em></span>
            <select name="unit" [(ngModel)]="draft.unitId">
              <option value="">Common area / whole property</option>
              @for (u of units(); track u.id) { <option [value]="u.id">Unit {{ u.number }}</option> }
            </select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Title</span><input name="title" [(ngModel)]="draft.title" required minlength="2" maxlength="160" placeholder="e.g. Leaking kitchen tap" /></label>
          <label class="field"><span>Priority</span>
            <select name="priority" [(ngModel)]="draft.priority"><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></label>
        </div>
        <label class="field"><span>Description</span><textarea name="description" [(ngModel)]="draft.description" required minlength="3" maxlength="2000"></textarea></label>
        <div class="field-row">
          <label class="field"><span>Assigned to <em>Optional</em></span><input name="assigned" [(ngModel)]="draft.assignedTo" maxlength="120" /></label>
          <label class="field"><span>Target date <em>Optional</em></span><input name="due" type="date" [(ngModel)]="draft.dueOn" /></label>
        </div>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="formOpen.set(false)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid">Create work order</button>
      </div>
    </form>
  }

  <div class="resource-toolbar" role="group" aria-label="Filter work orders">
    @for (option of filters; track option) {
      <button type="button" class="filter-button" [attr.aria-pressed]="filter() === option" (click)="filter.set(option); load()">{{ option | label }}</button>
    }
  </div>
  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Work order</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Dates</th><th scope="col"></th></tr></thead>
      <tbody>
        @for (w of orders(); track w.id) {
          <tr>
            <td><strong>{{ w.title }}</strong><small>{{ w.propertyName }}{{ w.unitNumber ? ' · Unit ' + w.unitNumber : '' }}{{ w.assignedTo ? ' · ' + w.assignedTo : '' }}</small><small>{{ w.description }}</small></td>
            <td><span [class]="tone(w.priority)">{{ w.priority | label }}</span></td>
            <td><span [class]="tone(w.status)">{{ w.status | label }}</span></td>
            <td>Opened {{ w.createdAt | moment: 'date' }}@if (w.dueOn) { <small>Target {{ w.dueOn | day }}</small> }@if (w.completedAt) { <small>Done {{ w.completedAt | moment: 'date' }}</small> }</td>
            <td>
              @if (canWrite()) {
                @switch (w.status) {
                  @case ('OPEN') {
                    <button class="text-button" type="button" (click)="move(w, 'IN_PROGRESS')">Start</button>
                    <button class="secondary" type="button" (click)="move(w, 'COMPLETED')">Complete</button>
                    <button class="text-button" type="button" (click)="move(w, 'CANCELLED')">Cancel</button>
                  }
                  @case ('IN_PROGRESS') {
                    <button class="secondary" type="button" (click)="move(w, 'COMPLETED')">Complete</button>
                    <button class="text-button" type="button" (click)="move(w, 'CANCELLED')">Cancel</button>
                  }
                  @default { <button class="text-button" type="button" (click)="move(w, 'OPEN')">Reopen</button> }
                }
              }
            </td>
          </tr>
        } @empty { <tr><td colspan="5" class="empty-cell">{{ loading() ? 'Loading…' : 'No work orders here.' }}</td></tr> }
      </tbody>
    </table>
  </section>
  @if (nextCursor()) { <button class="secondary" type="button" (click)="load(true)" [disabled]="loading()">{{ loading() ? 'Loading…' : 'Load more work orders' }}</button> }
</div>`,
})
export class MaintenancePage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly filters = ['active', 'closed', 'all'] as const;
  protected readonly filter = signal<'active' | 'closed' | 'all'>('active');
  protected readonly orders = signal<WorkOrder[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  private loadVersion = 0;
  protected readonly properties = signal<PropertyOption[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly tone = statusTone;
  protected readonly canWrite = computed(() => this.api.hasRole('OWNER', 'MANAGER', 'MAINTENANCE'));
  protected draft = { propertyId: '', unitId: '', title: '', description: '', priority: 'MEDIUM', assignedTo: '', dueOn: '' };

  ngOnInit(): void {
    this.load();
    this.api.get<PropertyOption[]>('/properties').subscribe((rows) => this.properties.set(rows));
  }

  protected units() {
    return this.properties().find((p) => p.id === this.draft.propertyId)?.units ?? [];
  }

  protected load(more = false): void {
    if (more && (this.loading() || !this.nextCursor())) return;
    const version = ++this.loadVersion;
    const cursor = more ? this.nextCursor() : null;
    if (!more) this.nextCursor.set(null);
    this.loading.set(true);
    this.error.set('');
    this.api.getList<WorkOrder>('/maintenance', { status: this.filter(), cursor }).subscribe({
      next: (page) => {
        if (version !== this.loadVersion) return;
        this.orders.update(rows => more ? appendPage(rows, page.items) : page.items);
        this.nextCursor.set(page.nextCursor);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        if (version !== this.loadVersion) return;
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected open(): void {
    this.draft = { propertyId: this.properties()[0]?.id ?? '', unitId: '', title: '', description: '', priority: 'MEDIUM', assignedTo: '', dueOn: '' };
    this.formOpen.set(true);
  }

  protected save(): void {
    this.saving.set(true);
    this.error.set('');
    this.api.post('/maintenance', { ...this.draft, unitId: this.draft.unitId || undefined, dueOn: this.draft.dueOn || undefined }).subscribe({
      next: () => {
        this.saving.set(false);
        this.formOpen.set(false);
        this.notice.set('Work order created.');
        this.load();
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected move(order: WorkOrder, status: WorkOrder['status']): void {
    this.api.patch<WorkOrder>(`/maintenance/${order.id}`, { status }).subscribe({
      next: (updated) => {
        this.load();
        this.notice.set(`“${order.title}” is now ${status.replace('_', ' ').toLowerCase()}.`);
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }
}
