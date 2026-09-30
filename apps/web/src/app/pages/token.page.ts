import { Component, type OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';

/**
 * Reads a one-time token from the URL fragment (never sent to servers) and
 * removes it from the address bar and history immediately.
 */
export function takeFragmentToken(): string {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const token = fragment.get('token') ?? query.get('token') ?? '';
  if (token) history.replaceState(history.state, '', window.location.pathname);
  return token;
}

@Component({
  selector: 'app-auth-shell',
  imports: [RouterLink],
  template: `
    <main class="auth-page">
      <section class="auth-story">
        <a class="auth-brand" routerLink="/auth"><span>R</span>RentFlow</a>
        <div>
          <p class="eyebrow">ACCOUNT SECURITY</p>
          <h1>Keep your rental records safe.</h1>
          <p>Links in RentFlow emails work once and expire quickly.</p>
        </div>
        <small>Never share these links with anyone.</small>
      </section>
      <section class="auth-form-wrap"><ng-content /></section>
    </main>`,
})
export class AuthShell {}

@Component({
  selector: 'app-reset-password-page',
  imports: [FormsModule, RouterLink, AuthShell],
  template: `<app-auth-shell>
    <form #form="ngForm" class="auth-form" (ngSubmit)="form.valid && submit()" [attr.aria-busy]="busy()">
      <a class="auth-mobile-brand" routerLink="/auth"><span>R</span>RentFlow</a>
      <p class="eyebrow">RESET PASSWORD</p>
      <h2>Choose a new password</h2>
      <p>This signs you out on every device.</p>
      @if (!token) {
        <div class="auth-error" role="alert">This link is incomplete. Request a new reset email.</div>
      }
      <label class="field"><span>New password</span>
        <input name="password" type="password" [(ngModel)]="password" required minlength="12" maxlength="128" autocomplete="new-password" />
        <small>At least 12 characters, not containing your email address.</small></label>
      <label class="field"><span>Confirm new password</span>
        <input name="confirm" type="password" [(ngModel)]="confirm" required autocomplete="new-password" /></label>
      @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }
      <button class="primary auth-submit" type="submit" [disabled]="busy() || !form.valid || !token">
        {{ busy() ? 'Saving…' : 'Save new password' }}
      </button>
      <div class="auth-switch"><a routerLink="/auth">Back to sign in</a></div>
    </form></app-auth-shell>`,
})
export class ResetPasswordPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  protected readonly token = takeFragmentToken();
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected password = '';
  protected confirm = '';

  protected submit(): void {
    if (this.password !== this.confirm) {
      this.error.set('The passwords do not match.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.api.publicPost('/auth/password/reset', { token: this.token, password: this.password }).subscribe({
      next: () => void this.router.navigate(['/auth'], { queryParams: { reset: 1 }, replaceUrl: true }),
      error: (error: ApiError) => {
        this.busy.set(false);
        this.error.set(error.message);
      },
    });
  }
}

@Component({
  selector: 'app-verify-email-page',
  imports: [RouterLink, AuthShell],
  template: `<app-auth-shell>
    <div class="auth-form" [attr.aria-busy]="state() === 'working'">
      <a class="auth-mobile-brand" routerLink="/auth"><span>R</span>RentFlow</a>
      <p class="eyebrow">EMAIL VERIFICATION</p>
      @switch (state()) {
        @case ('working') { <h2>Confirming your email…</h2> }
        @case ('done') {
          <h2>Email confirmed</h2>
          <p role="status">Your account can now be recovered by email if you forget your password.</p>
          <a class="primary auth-submit button-link" routerLink="/dashboard">Continue to RentFlow</a>
        }
        @default {
          <h2>We could not confirm this link</h2>
          <div class="auth-error" role="alert">{{ error() }}</div>
          <a class="secondary button-link" routerLink="/account">Send a new link from Account</a>
        }
      }
    </div></app-auth-shell>`,
})
export class VerifyEmailPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly state = signal<'working' | 'done' | 'failed'>('working');
  protected readonly error = signal('');

  ngOnInit(): void {
    const token = takeFragmentToken();
    if (!token) {
      this.state.set('failed');
      this.error.set('This link is incomplete.');
      return;
    }
    this.api.publicPost('/auth/email/verify', { token }).subscribe({
      next: () => {
        this.state.set('done');
        const profile = this.api.profile();
        if (profile) this.api.profile.set({ ...profile, user: { ...profile.user, emailVerified: true } });
      },
      error: (error: ApiError) => {
        this.state.set('failed');
        this.error.set(error.message);
      },
    });
  }
}
