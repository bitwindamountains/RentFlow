import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiClient } from '../core/api-client.service';

@Component({
  selector: 'app-invite-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './invite.page.html',
})
export class InvitePage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected name = '';
  protected password = '';
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly existingAccount = signal(false);
  private readonly token = this.route.snapshot.queryParamMap.get('token') ?? '';
  protected accept(): void {
    if (this.saving()) return;
    if (!this.token) {
      this.error.set('This invitation link is incomplete.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.api
      .acceptInvitation({
        token: this.token,
        ...(this.existingAccount() ? {} : { name: this.name }),
        password: this.password,
      })
      .subscribe({
        next: (result) => {
          this.password = '';
          void this.router.navigate(['/auth'], {
            queryParams: { email: result.email, workspace: result.workspace, invited: '1' },
            replaceUrl: true,
          });
        },
        error: (response) => {
          this.saving.set(false);
          this.error.set(
            response?.error?.message === 'ALREADY_A_MEMBER'
              ? 'You already have membership in this workspace. Sign in, or ask the owner to check your access.'
              : response?.error?.message === 'INVITATION_INVALID'
                ? 'This invitation is expired, revoked, or already used. Ask the owner for a new link.'
                : response?.error?.message === 'NAME_AND_STRONG_PASSWORD_REQUIRED'
                  ? 'New accounts need a name and a password of at least 12 characters.'
                  : (response?.error?.message ??
                    'The invitation could not be accepted. Please try again.'),
          );
        },
      });
  }
}
