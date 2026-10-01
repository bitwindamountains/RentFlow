import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { LabelPipe, MomentPipe } from '../core/format';
import type { PortalHome, PortalRepair } from '../core/models';

@Component({
  selector: 'app-portal-repairs-page',
  imports: [FormsModule, LabelPipe, MomentPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div>
      <p class="eyebrow">{{ home()?.organization?.name }}</p>
      <h1>Repairs</h1>
      <p>Report what needs fixing in your unit and follow its progress. For emergencies such as fire, flooding, or gas, call your landlord and the authorities first.</p>
    </div>
    @if (!formOpen() && leases().length) { <button class="primary" type="button" (click)="openForm()">Report a repair</button> }
  </section>
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }
  @if (!loading() && !leases().length) {
    <p class="inline-notice">You have no active rental to report repairs for. Contact your landlord directly.</p>
  }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && submit()">
      <h2>Report a repair</h2>
      <fieldset [disabled]="saving()">
        @if (leases().length > 1) {
          <label class="field"><span>Rental</span>
            <select name="lease" [(ngModel)]="draft.leaseId" required>
              @for (l of leases(); track l.id) { <option [value]="l.id">{{ l.propertyName }} · Unit {{ l.unitNumber }}</option> }
            </select></label>
        }
        <label class="field"><span>What needs fixing?</span>
          <input name="title" [(ngModel)]="draft.title" required minlength="3" maxlength="160" placeholder="e.g. Leaking kitchen faucet" /></label>
        <label class="field"><span>Details</span>
          <textarea name="description" [(ngModel)]="draft.description" required minlength="5" maxlength="2000"
            placeholder="Where is it, when did it start, and is anything damaged?"></textarea></label>
        <fieldset class="field">
          <legend>How soon?</legend>
          <div class="segmented" role="radiogroup" aria-label="How soon">
            @for (option of urgency; track option.value) {
              <label><input type="radio" name="priority" [value]="option.value" [(ngModel)]="draft.priority" /><span>{{ option.label }}</span></label>
            }
          </div>
        </fieldset>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="formOpen.set(false)" [disabled]="saving()">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid">{{ saving() ? 'Sending…' : 'Send' }}</button>
      </div>
    </form>
  }

  <section class="panel">
    <div class="attention-list">
      @for (r of repairs(); track r.id) {
        <div class="attention-item">
          <span [class]="'attention-icon ' + tone(r.status)" aria-hidden="true">{{ r.status === 'COMPLETED' ? '✓' : '•' }}</span>
          <span>
            <strong>{{ r.title }}</strong>
            <small>Unit {{ r.unitNumber }} · reported {{ r.createdAt | moment: 'date' }} · {{ r.priority | label }} priority</small>
          </span>
          <span [class]="'status ' + statusTone(r.status)">{{ r.status | label }}</span>
        </div>
      } @empty {
        <p class="empty-cell">{{ loading() ? 'Loading…' : 'No repair requests yet.' }}</p>
      }
    </div>
  </section>
</div>`,
  styles: `
    fieldset.field { border: 0; padding: 0; }
    legend { margin-bottom: 6px; font-weight: 600; font-size: var(--text-base); }
  `,
})
export class PortalRepairsPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly home = signal<PortalHome | null>(null);
  protected readonly repairs = signal<PortalRepair[]>([]);
  protected readonly leases = computed(() => (this.home()?.leases ?? []).filter((l) => l.status === 'ACTIVE'));
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly urgency = [
    { value: 'LOW', label: 'Can wait' },
    { value: 'MEDIUM', label: 'This week' },
    { value: 'HIGH', label: 'Soon' },
    { value: 'URGENT', label: 'Urgent' },
  ];
  protected draft = this.emptyDraft();

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    forkJoin({
      home: this.api.get<PortalHome>('/portal/home'),
      repairs: this.api.get<PortalRepair[]>('/portal/maintenance'),
    }).subscribe({
      next: ({ home, repairs }) => {
        this.home.set(home);
        this.repairs.set(repairs);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected openForm(): void {
    this.draft = this.emptyDraft();
    this.draft.leaseId = this.leases()[0]?.id ?? '';
    this.notice.set('');
    this.formOpen.set(true);
  }

  protected submit(): void {
    this.saving.set(true);
    this.error.set('');
    this.api
      .post('/portal/maintenance', {
        leaseId: this.draft.leaseId || undefined,
        title: this.draft.title,
        description: this.draft.description,
        priority: this.draft.priority,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.formOpen.set(false);
          this.notice.set('Sent. It is now on your landlord’s repair list.');
          this.load();
        },
        error: (error: ApiError) => {
          this.saving.set(false);
          this.error.set(error.message);
        },
      });
  }

  protected tone(status: string): string {
    return status === 'COMPLETED' ? 'green' : status === 'CANCELLED' ? 'blue' : 'orange';
  }

  protected statusTone(status: string): string {
    return status === 'COMPLETED' ? 'success' : status === 'CANCELLED' ? '' : 'warning';
  }

  private emptyDraft() {
    return { leaseId: '', title: '', description: '', priority: 'MEDIUM' };
  }
}
