import { Component, type OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient, type ApiError } from '../core/api-client.service';
import { LabelPipe, MomentPipe, statusTone } from '../core/format';
import type { Role } from '../core/models';

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  joinedAt: string | null;
}
interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

const ROLE_HELP: Record<string, string> = {
  MANAGER: 'Everything except staff management.',
  COLLECTOR: 'Records payments and deposits; read-only elsewhere.',
  MAINTENANCE: 'Work orders only; no tenant or financial data.',
  VIEWER: 'Read-only access to records and reports.',
};

@Component({
  selector: 'app-staff-page',
  imports: [FormsModule, LabelPipe, MomentPipe],
  template: `
<div class="page operations-page">
  <section class="page-heading">
    <div><h1>Staff & access</h1><p>Invite your team and remove access the moment someone leaves.</p></div>
    <button class="primary" type="button" (click)="formOpen.set(!formOpen())">{{ formOpen() ? 'Close' : 'Invite staff' }}</button>
  </section>
  @if (error()) { <div class="auth-error" role="alert">{{ error() }}</div> }
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }
  @if (inviteLink()) {
    <div class="panel">
      <p><strong>Invitation sent.</strong> We emailed the link. You can also share it privately (valid 7 days, works once):</p>
      <label class="field"><span>Invitation link</span><input readonly [value]="inviteLink()" (focus)="$any($event.target).select()" /></label>
      <button class="secondary" type="button" (click)="copy()">Copy link</button>
    </div>
  }

  @if (formOpen()) {
    <form #f="ngForm" class="panel operations-form" (ngSubmit)="f.valid && invite()">
      <fieldset [disabled]="saving()">
        <div class="field-row">
          <label class="field"><span>Email</span><input name="email" type="email" email [(ngModel)]="email" required /></label>
          <label class="field"><span>Role</span>
            <select name="role" [(ngModel)]="role">
              @for (r of roles; track r) { <option [value]="r">{{ r | label }}</option> }
            </select>
            <small>{{ help[role] }}</small></label>
        </div>
      </fieldset>
      <div class="modal-actions">
        <button class="secondary" type="button" (click)="formOpen.set(false)">Cancel</button>
        <button class="primary" type="submit" [disabled]="saving() || !f.valid">Send invitation</button>
      </div>
    </form>
  }

  <section class="data-panel table-wrap">
    <table>
      <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
      <tbody>
        @for (m of members(); track m.id) {
          <tr>
            <td><strong>{{ m.name }}</strong><small>{{ m.email }}</small></td>
            <td>
              @if (m.role === 'OWNER' || m.userId === me()) { {{ m.role | label }} }
              @else {
                <label class="sr-only" [attr.for]="'role-' + m.id">Role for {{ m.name }}</label>
                <select [id]="'role-' + m.id" [ngModel]="m.role" (ngModelChange)="update(m, { role: $event })">
                  @for (r of roles; track r) { <option [value]="r">{{ r | label }}</option> }
                </select>
              }
            </td>
            <td><span [class]="tone(m.status)">{{ m.status | label }}</span></td>
            <td>
              @if (m.role !== 'OWNER' && m.userId !== me()) {
                @if (m.status === 'ACTIVE') { <button class="text-button" type="button" (click)="update(m, { status: 'SUSPENDED' })">Suspend</button> }
                @else { <button class="text-button" type="button" (click)="update(m, { status: 'ACTIVE' })">Reactivate</button> }
                <button class="text-button danger-text" type="button" (click)="remove(m)">Remove</button>
              }
            </td>
          </tr>
        }
        @for (i of invitations(); track i.id) {
          <tr>
            <td><strong>{{ i.email }}</strong><small>Invited · expires {{ i.expiresAt | moment: 'date' }}</small></td>
            <td>{{ i.role | label }}</td>
            <td><span class="status warning">Pending</span></td>
            <td><button class="text-button" type="button" (click)="cancel(i)">Cancel invitation</button></td>
          </tr>
        }
      </tbody>
    </table>
  </section>
</div>`,
})
export class StaffPage implements OnInit {
  private readonly api = inject(ApiClient);
  protected readonly roles: Role[] = ['MANAGER', 'COLLECTOR', 'MAINTENANCE', 'VIEWER'];
  protected readonly help = ROLE_HELP;
  protected readonly members = signal<Member[]>([]);
  protected readonly invitations = signal<Invitation[]>([]);
  protected readonly inviteLink = signal('');
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly tone = statusTone;
  protected readonly me = () => this.api.profile()?.user.id;
  protected email = '';
  protected role: Role = 'MANAGER';

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.get<{ members: Member[]; invitations: Invitation[] }>('/staff').subscribe({
      next: (data) => {
        this.members.set(data.members);
        this.invitations.set(data.invitations);
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected invite(): void {
    this.saving.set(true);
    this.error.set('');
    this.api.post<{ link: string }>('/staff/invitations', { email: this.email, role: this.role }).subscribe({
      next: (result) => {
        this.saving.set(false);
        this.formOpen.set(false);
        this.inviteLink.set(result.link);
        this.email = '';
        this.load();
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        this.error.set(error.message);
      },
    });
  }

  protected update(member: Member, change: { role?: Role; status?: 'ACTIVE' | 'SUSPENDED' }): void {
    if (change.status === 'SUSPENDED' && !confirm(`Suspend ${member.name}? They are signed out immediately.`)) return;
    this.api.patch(`/staff/${member.id}`, change).subscribe({
      next: () => {
        this.notice.set(`${member.name} updated.`);
        this.load();
      },
      error: (error: ApiError) => {
        this.error.set(error.message);
        this.load();
      },
    });
  }

  protected remove(member: Member): void {
    if (!confirm(`Remove ${member.name}'s access? They are signed out immediately. You can invite them again later.`)) return;
    this.api.delete(`/staff/${member.id}`).subscribe({
      next: () => {
        this.notice.set(`${member.name} no longer has access.`);
        this.load();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected cancel(invitation: Invitation): void {
    this.api.delete(`/staff/invitations/${invitation.id}`).subscribe({
      next: () => {
        this.notice.set(`Invitation for ${invitation.email} cancelled.`);
        this.load();
      },
      error: (error: ApiError) => this.error.set(error.message),
    });
  }

  protected copy(): void {
    void navigator.clipboard?.writeText(this.inviteLink()).then(() => this.notice.set('Link copied.'));
  }
}
