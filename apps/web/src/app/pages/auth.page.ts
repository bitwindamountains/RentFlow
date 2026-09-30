import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { finalize } from 'rxjs';
import { ApiClient } from '../core/api-client.service';

@Component({ selector: 'app-auth-page', imports: [FormsModule], templateUrl: './auth.page.html' })
export class AuthPage {
  protected readonly mode = signal<'login' | 'register'>('login');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected name = '';
  protected organizationName = '';
  protected email = '';
  protected password = '';
  protected workspace = '';
  protected readonly invitationAccepted: boolean;

  constructor(
    private readonly api: ApiClient,
    private readonly router: Router,
    route: ActivatedRoute,
  ) {
    this.email = route.snapshot.queryParamMap.get('email') ?? '';
    this.workspace = route.snapshot.queryParamMap.get('workspace') ?? '';
    this.invitationAccepted = route.snapshot.queryParamMap.get('invited') === '1';
  }

  protected submit(): void {
    if (this.busy()) return;
    this.error.set('');
    this.busy.set(true);
    const request =
      this.mode() === 'register'
        ? this.api.register({
            email: this.email,
            password: this.password,
            name: this.name,
            organizationName: this.organizationName,
          })
        : this.api.login({
            email: this.email,
            password: this.password,
            workspace: this.workspace.trim() || undefined,
          });
    request.pipe(finalize(() => this.busy.set(false))).subscribe({
      next: () => void this.router.navigateByUrl('/dashboard'),
      error: (error) =>
        this.error.set(
          error.status === 0
            ? 'Cannot connect to RentFlow. Check your connection and try again.'
            : error.status === 401
              ? 'Check your email, password, and workspace access, then try again.'
              : error?.error?.message === 'EMAIL_EXISTS'
                ? 'This email already has an account. Sign in instead.'
                : 'We could not complete that request. Check your details and try again.',
        ),
    });
  }
}
