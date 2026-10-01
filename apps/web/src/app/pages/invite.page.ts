import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { takeFragmentToken } from './token.page';

@Component({
  selector: 'app-invite-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './invite.page.html',
})
export class InvitePage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  protected name = '';
  protected password = '';
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly existingAccount = signal(false);
  private readonly token = takeFragmentToken();

  protected accept(): void {
    if (this.saving()) return;
    if (!this.token) {
      this.error.set('This invitation link is incomplete. Ask the owner for a new link.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.api
      .publicPost<{ accepted: boolean; email: string; workspace: string }>('/staff/invitations/accept', {
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
        error: (error: ApiError) => {
          this.saving.set(false);
          if (error.code === 'INVALID_CREDENTIALS' && !this.existingAccount()) this.existingAccount.set(true);
          this.error.set(error.message);
        },
      });
  }
}
