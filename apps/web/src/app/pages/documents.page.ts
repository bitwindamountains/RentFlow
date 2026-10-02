import { Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { MomentPipe } from '../core/format';
import { ACCEPTED_FILE_TYPES as ACCEPTED, describeFile } from '../core/files';
import type { DocumentRecord, Property, TenantSummary } from '../core/models';
const MAX_BYTES = 10 * 1_048_576;

@Component({
  selector: 'app-documents-page',
  imports: [FormsModule, MomentPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><p class="eyebrow">OPERATIONS</p><h1>Documents</h1>
      <p>Signed leases, IDs, and receipts. Uploaded files are stored privately and only people in this workspace can open them.</p></div>
    @if (canWrite()) { <button class="primary" type="button" (click)="formOpen.set(!formOpen())">{{ formOpen() ? 'Close' : 'Add document' }}</button> }
  </section>
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && save()">
      <div class="segmented" role="radiogroup" aria-label="How to add the document">
        <label><input type="radio" name="mode" value="file" [checked]="mode() === 'file'" (change)="mode.set('file')" /><span>Upload a file</span></label>
        <label><input type="radio" name="mode" value="link" [checked]="mode() === 'link'" (change)="mode.set('link')" /><span>Link to a file</span></label>
      </div>
      <fieldset [disabled]="saving()" class="document-fields">
        @if (mode() === 'file') {
          <label class="field"><span>File <em>PDF, JPEG, PNG, or WebP · up to 10 MB</em></span>
            <input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" (change)="pick($event)" required />
            @if (file(); as chosen) { <small>{{ describeFile(chosen.type, chosen.size) }}</small> }
          </label>
        }
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
        @if (mode() === 'link') {
          <label class="field"><span>Secure HTTPS link</span>
            <input name="url" type="url" [(ngModel)]="draft.url" required pattern="https://.+" placeholder="https://…" maxlength="2000" />
            <small>Anyone with this link can open the file unless your storage restricts access. Do not use public links for IDs.</small></label>
        }
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="formOpen.set(false)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid || (mode() === 'file' && !file())">
          {{ saving() ? (mode() === 'file' ? 'Uploading…' : 'Saving…') : mode() === 'file' ? 'Upload' : 'Save link' }}
        </button>
      </div>
    </form>
  }

  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Category</th><th scope="col">About</th><th scope="col">Added</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>
        @for (d of documents(); track d.id) {
          <tr>
            <td><a [href]="href(d)" target="_blank" rel="noopener noreferrer"><strong>{{ d.name }}</strong></a></td>
            <td>{{ d.kind === 'file' ? describeFile(d.contentType, d.sizeBytes) : 'External link' }}</td>
            <td>{{ d.category }}</td>
            <td>{{ describe(d) }}@if (d.sharedWithTenant) { <small class="status success">Tenant can see</small> }</td>
            <td>{{ d.createdAt | moment: 'date' }}</td>
            <td class="row-actions">@if (canWrite()) {
              @if (shareable(d)) { <button class="text-button" type="button" (click)="toggleShare(d)">{{ d.sharedWithTenant ? 'Stop sharing' : 'Share with tenant' }}</button> }
              <button class="text-button" type="button" (click)="remove(d)">Remove</button>
            }</td>
          </tr>
        } @empty { <tr><td colspan="6" class="empty-cell">{{ loading() ? 'Loading…' : 'No documents yet.' }}</td></tr> }
      </tbody>
    </table>
  </section>
</div>`,
  styles: `
    .segmented { margin-bottom: var(--space-5); }
    .row-actions { white-space: nowrap; }
    .row-actions .text-button + .text-button { margin-left: var(--space-3); }
    td small.status { display: inline-flex; margin-left: var(--space-2); }
    input[type='file'] { padding: 9px 12px; cursor: pointer; }
    input[type='file']::file-selector-button {
      margin-right: var(--space-3);
      padding: 6px 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text);
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
  `,
})
export class DocumentsPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly documents = signal<DocumentRecord[]>([]);
  protected readonly tenants = signal<TenantSummary[]>([]);
  protected readonly properties = signal<Property[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly mode = signal<'file' | 'link'>('file');
  protected readonly file = signal<File | null>(null);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly canWrite = computed(() => this.api.hasRole('OWNER', 'MANAGER'));
  protected draft = this.emptyDraft();

  ngOnInit(): void {
    this.draft.entityType = this.query.get('entityType') ?? '';
    this.draft.entityId = this.query.get('entityId') ?? '';
    if (this.draft.entityType && this.canWrite()) this.formOpen.set(true);
    this.load();
  }

  protected options(): Array<{ id: string; label: string }> {
    return this.draft.entityType === 'Tenant'
      ? this.tenants().map((t) => ({ id: t.id, label: `${t.firstName} ${t.lastName}` }))
      : this.properties().map((p) => ({ id: p.id, label: p.name }));
  }

  protected describe(d: DocumentRecord): string {
    if (!d.entityType) return 'General';
    const label =
      d.entityType === 'Tenant'
        ? this.tenants().find((t) => t.id === d.entityId)
        : this.properties().find((p) => p.id === d.entityId);
    if (!label) return d.entityType;
    return 'firstName' in label ? `${label.firstName} ${label.lastName}` : label.name;
  }

  protected href(d: DocumentRecord): string {
    return d.kind === 'file' ? this.api.downloadUrl(`/documents/${d.id}/file`) : (d.url ?? '');
  }

  protected describeFile(type: string | null | undefined, size: number | null | undefined): string {
    return describeFile(type, size);
  }

  protected shareable(d: DocumentRecord): boolean {
    return d.entityType === 'Tenant' || d.entityType === 'Lease';
  }

  protected toggleShare(d: DocumentRecord): void {
    const shared = !d.sharedWithTenant;
    this.api.patch<DocumentRecord>(`/documents/${d.id}/sharing`, { shared }).subscribe({
      next: () => {
        this.notice.set(shared ? `"${d.name}" is now in the tenant's portal.` : `"${d.name}" is no longer shared.`);
        this.load();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected pick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    this.error.set('');
    if (chosen && !ACCEPTED[chosen.type]) {
      this.error.set('Choose a PDF, JPEG, PNG, or WebP file. Photos from an iPhone can be shared as JPEG.');
      input.value = '';
      this.file.set(null);
      return;
    }
    if (chosen && chosen.size > MAX_BYTES) {
      this.error.set('That file is larger than 10 MB. Scan at a lower resolution or split the PDF.');
      input.value = '';
      this.file.set(null);
      return;
    }
    this.file.set(chosen);
    if (chosen && !this.draft.name.trim()) this.draft.name = chosen.name.replace(/\.[^.]+$/, '').slice(0, 160);
  }

  private load(): void {
    this.loading.set(true);
    forkJoin({
      documents: this.api.get<DocumentRecord[]>('/documents'),
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
    const details = {
      name: this.draft.name,
      category: this.draft.category,
      entityType: this.draft.entityType || undefined,
      entityId: this.draft.entityId || undefined,
    };
    const file = this.file();
    const request =
      this.mode() === 'file' && file
        ? this.api.upload<DocumentRecord>('/documents/files', file, details)
        : this.api.post<DocumentRecord>('/documents', { ...details, url: this.draft.url });
    this.saving.set(true);
    this.error.set('');
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.formOpen.set(false);
        this.notice.set(this.mode() === 'file' ? 'Document uploaded.' : 'Document linked.');
        this.draft = this.emptyDraft();
        this.file.set(null);
        this.load();
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected remove(d: DocumentRecord): void {
    const message =
      d.kind === 'file'
        ? `Delete "${d.name}"? The file is permanently erased.`
        : `Remove the link to "${d.name}"? The file in your storage is not deleted.`;
    if (!confirm(message)) return;
    this.api.delete(`/documents/${d.id}`).subscribe({
      next: () => {
        this.notice.set(d.kind === 'file' ? 'Document deleted.' : 'Link removed.');
        this.load();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  private emptyDraft() {
    return { name: '', category: 'Lease', entityType: '', entityId: '', url: '' };
  }
}
