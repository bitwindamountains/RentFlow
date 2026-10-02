import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { finalize } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { homeFor, type Profile } from '../core/models';

type Mode = 'login' | 'register' | 'forgot' | 'mfa';

@Component({ selector: 'app-auth-page', imports: [FormsModule], templateUrl: './auth.page.html' })
export class AuthPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  protected readonly mode = signal<Mode>('login');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected name = '';
  protected organizationName = '';
  protected email = '';
  protected password = '';
  protected workspace = '';
  protected code = '';
  /** Typing a recovery code instead of an app code. */
  protected readonly useRecovery = signal(false);
  private challenge = '';

  constructor() {
    const query = inject(ActivatedRoute).snapshot.queryParamMap;
    this.email = query.get('email') ?? '';
    this.workspace = query.get('workspace') ?? '';
    if (query.get('invited') === '1') this.notice.set('Invitation accepted. Sign in below to open your new workspace.');
    else if (query.get('reset') === '1') this.notice.set('Password updated. Sign in with your new password.');
    else if (query.get('expired') === '1') this.notice.set('Your session ended. Sign in again to continue.');
  }

  protected switchMode(mode: Mode): void {
    this.mode.set(mode);
    this.error.set('');
    this.notice.set('');
    this.code = '';
    this.useRecovery.set(false);
  }

  protected submit(): void {
    if (this.busy()) return;
    this.error.set('');
    this.busy.set(true);
    if (this.mode() === 'forgot') {
      this.api
        .publicPost('/auth/password/forgot', { email: this.email })
        .pipe(finalize(() => this.busy.set(false)))
        .subscribe({
          next: () => {
            this.notice.set('If an account exists for that email, a reset link is on its way. It expires in 30 minutes.');
            this.mode.set('login');
          },
          error: (error: ApiError) => this.error.set(error.message),
        });
      return;
    }
    const workspace = this.workspace.trim() || undefined;
    const request =
      this.mode() === 'register'
        ? this.api.session('/auth/register', {
            email: this.email,
            password: this.password,
            name: this.name,
            organizationName: this.organizationName,
          })
        : this.mode() === 'mfa'
          ? this.api.session('/auth/login/mfa', { challenge: this.challenge, code: this.code.trim(), workspace })
          : this.api.login({ email: this.email, password: this.password, workspace });
    request.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: (result) => {
        this.password = '';
        if ('mfaRequired' in result) {
          this.challenge = result.challenge;
          this.switchMode('mfa');
          return;
        }
        this.code = '';
        void this.router.navigateByUrl(homeFor((result as Profile).role));
      },
      error: (error: ApiError) => {
        if (error.code === 'MFA_CHALLENGE_INVALID') {
          this.switchMode('login');
          this.notice.set('That sign-in attempt expired. Enter your password again.');
          return;
        }
        this.error.set(error.code === 'RATE_LIMITED' ? 'Too many attempts. Wait a few minutes, then try again.' : error.message);
      },
    });
  }
}
