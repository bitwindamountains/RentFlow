import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { finalize } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';

type Mode = 'login' | 'register' | 'forgot';

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
    const request =
      this.mode() === 'register'
        ? this.api.session('/auth/register', {
            email: this.email,
            password: this.password,
            name: this.name,
            organizationName: this.organizationName,
          })
        : this.api.session('/auth/login', {
            email: this.email,
            password: this.password,
            workspace: this.workspace.trim() || undefined,
          });
    request.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: (profile) => {
        this.password = '';
        void this.router.navigateByUrl(profile.role === 'MAINTENANCE' ? '/maintenance' : '/dashboard');
      },
      error: (error: ApiError) =>
        this.error.set(
          error.code === 'RATE_LIMITED'
            ? 'Too many attempts. Wait a few minutes, then try again.'
            : error.message,
        ),
    });
  }
}
