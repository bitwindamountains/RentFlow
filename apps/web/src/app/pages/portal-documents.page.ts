import { Component, type OnInit, inject, signal } from '@angular/core';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { describeFile } from '../core/files';
import { MomentPipe } from '../core/format';
import type { PortalDocument } from '../core/models';

@Component({
  selector: 'app-portal-documents-page',
  imports: [MomentPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div>
      <p class="eyebrow">MY RENTAL</p>
      <h1>Documents</h1>
      <p>Files your landlord has shared with you, such as your lease and house rules.</p>
    </div>
  </section>
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }
  <section class="panel">
    <div class="attention-list">
      @for (d of documents(); track d.id) {
        <a class="attention-item" [href]="href(d)" target="_blank" rel="noopener noreferrer">
          <span class="attention-icon blue" aria-hidden="true">{{ d.kind === 'file' ? '↓' : '↗' }}</span>
          <span>
            <strong>{{ d.name }}</strong>
            <small>{{ d.category }} · {{ d.kind === 'file' ? describe(d) : 'Opens in a new tab' }} · shared {{ d.createdAt | moment: 'date' }}</small>
          </span>
        </a>
      } @empty {
        <p class="empty-cell">{{ loading() ? 'Loading…' : 'Nothing has been shared with you yet.' }}</p>
      }
    </div>
  </section>
</div>`,
})
export class PortalDocumentsPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly documents = signal<PortalDocument[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  ngOnInit(): void {
    this.api.get<PortalDocument[]>('/portal/documents').subscribe({
      next: (rows) => {
        this.documents.set(rows);
        this.loading.set(false);
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.loading.set(false);
      },
    });
  }

  protected href(d: PortalDocument): string {
    return d.kind === 'file' ? this.api.downloadUrl(`/portal/documents/${d.id}/file`) : (d.url ?? '');
  }

  protected describe(d: PortalDocument): string {
    return describeFile(d.contentType, d.sizeBytes);
  }
}
