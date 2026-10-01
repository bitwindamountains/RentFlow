import { Component, effect, inject, input, signal } from '@angular/core';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { MomentPipe } from '../core/format';
import type { PortalAccess } from '../core/models';

/** Tenant detail: invite to, check, and end tenant portal access. Managers only. */
@Component({
  selector: 'app-portal-access',
  imports: [MomentPipe],
  template: `
<section class="panel portal-access" aria-labelledby="portal-access-title">
  <div class="panel-title">
    <div>
      <h2 id="portal-access-title">Tenant portal</h2>
      <p>
        @switch (access()?.status) {
          @case ('ACTIVE') { Active for {{ access()!.email }} since {{ access()!.since | moment: 'date' }}. }
          @case ('INVITED') { Invitation sent to {{ access()!.email }}; it expires {{ access()!.expiresAt | moment: 'date' }}. }
          @case ('SUSPENDED') { Suspended for {{ access()!.email }}. }
          @default { Let this tenant see their balance and receipts, report payments, and request repairs. }
        }
      </p>
    </div>
    <div class="heading-actions">
      @if (access()?.status === 'NONE' || access()?.status === 'INVITED') {
        <button class="secondary" type="button" (click)="invite()" [disabled]="busy() || !email()">
          {{ access()?.status === 'INVITED' ? 'Send a new link' : 'Invite to portal' }}
        </button>
      }
      @if (access()?.status && access()?.status !== 'NONE') {
        <button class="text-button" type="button" (click)="revoke()" [disabled]="busy()">Remove access</button>
      }
    </div>
  </div>
  @if (!email() && access()?.status === 'NONE') {
    <p class="review-warning">Add the tenant’s email address to invite them.</p>
  }
  @if (link()) {
    <div class="invite-link">
      <label class="field"><span>Invitation link <em>Also sent by email · valid 7 days</em></span>
        <input readonly [value]="link()" (focus)="$any($event.target).select()" /></label>
      <button class="secondary" type="button" (click)="copy()">{{ copied() ? 'Copied' : 'Copy link' }}</button>
    </div>
    <small>You can also send it by SMS or Messenger. Anyone with the link can claim the account, so send it only to the tenant.</small>
  }
  @if (error()) { <p class="auth-error" role="alert">{{ error() }}</p> }
</section>`,
  styles: `
    .portal-access { margin: var(--space-4) 0; }
    .invite-link { display: flex; align-items: end; gap: var(--space-2); }
    .invite-link .field { flex: 1; margin-bottom: 0; }
    .portal-access > small { display: block; margin-top: var(--space-2); color: var(--text-muted); font-size: var(--text-xs); }
  `,
})
export class PortalAccessComponent {
  private readonly api = inject(ApiClient);
  readonly tenantId = input.required<string>();
  readonly email = input<string | null>(null);
  protected readonly access = signal<PortalAccess | null>(null);
  protected readonly link = signal('');
  protected readonly busy = signal(false);
  protected readonly copied = signal(false);
  protected readonly error = signal('');

  constructor() {
    effect(() => this.load(this.tenantId()));
  }

  private load(id: string): void {
    this.api.get<PortalAccess>(`/tenants/${id}/portal`).subscribe({
      next: (access) => this.access.set(access),
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected invite(): void {
    this.busy.set(true);
    this.error.set('');
    this.api.post<PortalAccess>(`/tenants/${this.tenantId()}/portal/invite`, {}).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.link.set(result.link ?? '');
        this.copied.set(false);
        this.load(this.tenantId());
      },
      error: (error: ApiError) => {
        this.busy.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected revoke(): void {
    if (!confirm('Remove portal access? The tenant is signed out immediately. Their records are not affected.')) return;
    this.busy.set(true);
    this.api.delete(`/tenants/${this.tenantId()}/portal`).subscribe({
      next: () => {
        this.busy.set(false);
        this.link.set('');
        this.load(this.tenantId());
      },
      error: (error: ApiError) => {
        this.busy.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link());
      this.copied.set(true);
    } catch {
      this.error.set('Copy did not work here. Select the link and copy it manually.');
    }
  }
}
