import { Component, type OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { LabelPipe, MomentPipe } from '../core/format';
import { ThemeService, type ThemePreference } from '../core/theme.service';

interface SessionRow {
  id: string;
  workspace: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

@Component({
  selector: 'app-account-page',
  imports: [FormsModule, MomentPipe, LabelPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><p class="eyebrow">ACCOUNT</p><h1>Account & security</h1><p>{{ api.profile()?.user?.email }}</p></div>
  </section>
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }

  <section class="panel">
    <h2>Email</h2>
    @if (api.profile()?.user?.emailVerified) {
      <p><span class="status success">Verified</span> Password reset emails go to this address.</p>
    } @else {
      <p><span class="status warning">Not verified</span> Verify your email so you can recover your account.</p>
      <button class="secondary" type="button" (click)="resend()" [disabled]="busy()">Send verification email</button>
    }
  </section>

  <section class="panel">
    <h2>Appearance</h2>
    <p>Applies to this device only.</p>
    <div class="segmented" role="radiogroup" aria-label="Colour theme">
      @for (option of themes; track option.value) {
        <label>
          <input type="radio" name="theme" [value]="option.value" [checked]="theme.preference() === option.value" (change)="theme.set(option.value)" />
          <span>{{ option.label }}</span>
        </label>
      }
    </div>
  </section>

  @if ((api.profile()?.workspaces?.length ?? 0) > 1) {
    <section class="panel">
      <h2>Workspaces</h2>
      <label class="field"><span>Switch workspace</span>
        <select [ngModel]="api.profile()?.organization?.slug" (ngModelChange)="switchTo($event)">
          @for (w of api.profile()?.workspaces; track w.slug) { <option [value]="w.slug">{{ w.name }} ({{ w.role | label }})</option> }
        </select></label>
    </section>
  }

  <form #pw="ngForm" class="panel operations-form" (ngSubmit)="pw.valid && changePassword()">
    <h2>Change password</h2>
    <fieldset [disabled]="busy()">
      <label class="field"><span>Current password</span><input name="current" type="password" [(ngModel)]="current" required autocomplete="current-password" /></label>
      <div class="field-row">
        <label class="field"><span>New password</span><input name="next" type="password" [(ngModel)]="next" required minlength="12" maxlength="128" autocomplete="new-password" /></label>
        <label class="field"><span>Confirm new password</span><input name="confirm" type="password" [(ngModel)]="confirmation" required autocomplete="new-password" /></label>
      </div>
      <small>Changing your password signs out your other devices.</small>
    </fieldset>
    <div class="modal-actions"><button class="primary" type="submit" [disabled]="busy() || !pw.valid">Update password</button></div>
  </form>

  <section class="panel">
    <div class="panel-title">
      <div><h2>Signed-in devices</h2><p>Sessions end after inactivity or when you sign out.</p></div>
      <button class="secondary" type="button" (click)="revokeOthers()" [disabled]="sessions().length < 2">Sign out other devices</button>
    </div>
    <ul>
      @for (s of sessions(); track s.id) {
        <li>
          <strong>{{ device(s.userAgent) }}</strong> · {{ s.workspace }} · last active {{ s.lastSeenAt | moment }}
          @if (s.current) { <span class="status success">This device</span> }
          @else { <button class="text-button" type="button" (click)="revoke(s)">Sign out</button> }
        </li>
      }
    </ul>
  </section>
</div>`,
})
export class AccountPage implements OnInit {
  protected readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeService);
  protected readonly themes: Array<{ value: ThemePreference; label: string }> = [
    { value: 'system', label: 'Match device' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
  protected readonly sessions = signal<SessionRow[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected current = '';
  protected next = '';
  protected confirmation = '';

  ngOnInit(): void {
    this.loadSessions();
  }

  private loadSessions(): void {
    this.api.get<SessionRow[]>('/auth/sessions').subscribe({ next: (rows) => this.sessions.set(rows) });
  }

  protected device(agent: string | null): string {
    if (!agent) return 'Unknown device';
    const os = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'macOS' : 'Device';
    const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
    return `${browser} on ${os}`;
  }

  protected resend(): void {
    this.busy.set(true);
    this.api.post('/auth/email/resend', {}).subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set('Verification email sent. Check your inbox.');
      },
      error: (error: ApiError) => {
        this.busy.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected changePassword(): void {
    if (this.next !== this.confirmation) {
      this.error.set('The new passwords do not match.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.api.post('/auth/password', { currentPassword: this.current, newPassword: this.next }).subscribe({
      next: () => {
        this.busy.set(false);
        this.current = this.next = this.confirmation = '';
        this.notice.set('Password updated. Other devices were signed out.');
        this.loadSessions();
      },
      error: (error: ApiError) => {
        this.busy.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected revoke(session: SessionRow): void {
    this.api.delete(`/auth/sessions/${session.id}`).subscribe({ next: () => this.loadSessions() });
  }

  protected revokeOthers(): void {
    this.api.post<{ revoked: number }>('/auth/sessions/revoke-others', {}).subscribe({
      next: (result) => {
        this.notice.set(`${result.revoked} other session(s) signed out.`);
        this.loadSessions();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected switchTo(slug: string): void {
    if (!slug || slug === this.api.profile()?.organization.slug) return;
    this.api.session('/auth/switch-workspace', { workspace: slug }).subscribe({
      next: (profile) => void this.router.navigateByUrl(profile.role === 'MAINTENANCE' ? '/maintenance' : '/dashboard'),
      error: (error: ApiError) => this.error.set(error.message),
    });
  }
}
