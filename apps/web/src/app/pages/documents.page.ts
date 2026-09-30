import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { MomentPipe } from '../core/format';
import type { Property, TenantSummary } from '../core/models';

interface DocumentLink {
  id: string;
  name: string;
  category: string;
  entityType: string | null;
  entityId: string | null;
  url: string;
  createdAt: string;
}

@Component({
  selector: 'app-documents-page',
  imports: [FormsModule, MomentPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><p class="eyebrow">OPERATIONS</p><h1>Documents</h1>
      <p>Links to leases, IDs, and receipts kept in your own secure storage (e.g. Google Drive with restricted sharing).</p></div>
    @if (canWrite()) { <button class="primary" type="button" (click)="formOpen.set(!formOpen())">{{ formOpen() ? 'Close' : 'Link document' }}</button> }
  </section>
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && save()">
      <fieldset [disabled]="saving()">
        <div class="field-row">
          <label class="field"><span>Document name</span><input name="name" [(ngModel)]="draft.name" required minlength="2" maxlength="160" /></label>
          <label class="field"><span>Category</span>
            <select name="category" [(ngModel)]="draft.category"><option>Lease</option><option>Identity</option><option>Receipt</option><option>Property</option><option>Other</option></select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>About</span>
            <select name="entityType" [(ngModel)]="draft.entityType" (ngModelChange)="draft.entityId = ''">
              <option value="">Nothing specific</option><option value="Tenant">A tenant</option><option value="Property">A property</option>
            </select></label>
          @if (draft.entityType) {
            <label class="field"><span>{{ draft.entityType }}</span>
              <select name="entityId" [(ngModel)]="draft.entityId" required>
                @for (o of options(); track o.id) { <option [value]="o.id">{{ o.label }}</option> }
              </select></label>
          }
        </div>
        <label class="field"><span>Secure HTTPS link</span>
          <input name="url" type="url" [(ngModel)]="draft.url" required pattern="https://.+" placeholder="https://…" maxlength="2000" />
          <small>Anyone with this link can open the file unless your storage restricts access. Do not use public links for IDs.</small></label>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="formOpen.set(false)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid">Save link</button>
      </div>
    </form>
  }

  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Document</th><th scope="col">Category</th><th scope="col">About</th><th scope="col">Added</th><th scope="col"></th></tr></thead>
      <tbody>
        @for (d of documents(); track d.id) {
          <tr>
            <td><a [href]="d.url" target="_blank" rel="noopener noreferrer"><strong>{{ d.name }}</strong></a></td>
            <td>{{ d.category }}</td>
            <td>{{ describe(d) }}</td>
            <td>{{ d.createdAt | moment: 'date' }}</td>
            <td>@if (canWrite()) { <button class="text-button" type="button" (click)="remove(d)">Remove</button> }</td>
          </tr>
        } @empty { <tr><td colspan="5" class="empty-cell">{{ loading() ? 'Loading…' : 'No documents linked yet.' }}</td></tr> }
      </tbody>
    </table>
  </section>
</div>`,
})
export class DocumentsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly documents = signal<DocumentLink[]>([]);
  protected readonly tenants = signal<TenantSummary[]>([]);
  protected readonly properties = signal<Property[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly canWrite = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected draft = {
    name: '',
    category: 'Lease',
    entityType: this.query.get('entityType') ?? '',
    entityId: this.query.get('entityId') ?? '',
    url: '',
  };

  ngOnInit(): void {
    if (this.draft.entityType && this.canWrite()) this.formOpen.set(true);
    this.load();
  }

  protected options(): Array<{ id: string; label: string }> {
    return this.draft.entityType === 'Tenant'
      ? this.tenants().map((t) => ({ id: t.id, label: `${t.firstName} ${t.lastName}` }))
      : this.properties().map((p) => ({ id: p.id, label: p.name }));
  }

  protected describe(d: DocumentLink): string {
    if (!d.entityType) return 'General';
    const label =
      d.entityType === 'Tenant'
        ? this.tenants().find((t) => t.id === d.entityId)
        : this.properties().find((p) => p.id === d.entityId);
    if (!label) return d.entityType;
    return 'firstName' in label ? `${label.firstName} ${label.lastName}` : label.name;
  }

  private load(): void {
    this.loading.set(true);
    forkJoin({
      documents: this.api.get<DocumentLink[]>('/documents'),
      tenants: this.api.get<TenantSummary[]>('/tenants'),
      properties: this.api.get<Property[]>('/properties'),
    }).subscribe({
      next: ({ documents, tenants, properties }) => {
        this.documents.set(documents);
        this.tenants.set(tenants);
        this.properties.set(properties);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected save(): void {
    this.saving.set(true);
    this.error.set('');
    this.api
      .post('/documents', {
        name: this.draft.name,
        category: this.draft.category,
        url: this.draft.url,
        entityType: this.draft.entityType || undefined,
        entityId: this.draft.entityId || undefined,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.formOpen.set(false);
          this.draft = { name: '', category: 'Lease', entityType: '', entityId: '', url: '' };
          this.notice.set('Document linked.');
          this.load();
        },
        error: (error: ApiError) => {
          this.saving.set(false);
          this.error.set(error.message);
        },
      });
  }

  protected remove(d: DocumentLink): void {
    if (!confirm(`Remove the link to "${d.name}"? The file in your storage is not deleted.`)) return;
    this.api.delete(`/documents/${d.id}`).subscribe({
      next: () => {
        this.notice.set('Link removed.');
        this.load();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }
}
