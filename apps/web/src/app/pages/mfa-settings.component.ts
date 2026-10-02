import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { ApiClient, type ApiError } from '../core/api-client.service';

type Step = 'idle' | 'password' | 'scan' | 'codes' | 'disable' | 'regenerate';

interface Setup {
  secret: string;
  uri: string;
  qr: string;
}

/** Account → Two-step sign-in: set up an authenticator app, recovery codes, and turning it off. */
@Component({
  selector: 'app-mfa-settings',
  imports: [FormsModule, NgTemplateOutlet],
  template: `
<section class="panel mfa-settings">
  <div class="panel-title">
    <div>
      <h2>Two-step sign-in</h2>
      <p>
        @if (enabled()) { <span class="status success">On</span> Signing in needs your password and a code from your authenticator app. }
        @else { Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, and others) as well as your password. }
      </p>
    </div>
    @if (step() === 'idle') {
      @if (enabled()) {
        <div class="mfa-actions">
          <button class="secondary" type="button" (click)="open('regenerate')">New recovery codes</button>
          <button class="text-button" type="button" (click)="open('disable')">Turn off</button>
        </div>
      } @else {
        <button class="primary" type="button" (click)="open('password')">Turn on</button>
      }
    }
  </div>
  @if (error()) { <div class="inline-notice" role="alert">{{ error() }}</div> }
  @if (notice()) { <div class="inline-notice" role="status">{{ notice() }}</div> }

  @switch (step()) {
    @case ('password') {
      <form class="operations-form" (ngSubmit)="start()">
        <label class="field"><span>Confirm your password</span>
          <input name="password" type="password" [(ngModel)]="password" required autocomplete="current-password" autofocus /></label>
        <div class="modal-actions">
          <button class="secondary" type="button" (click)="close()">Cancel</button>
          <button class="primary" type="submit" [disabled]="busy() || !password">Continue</button>
        </div>
      </form>
    }
    @case ('scan') {
      @if (setup(); as s) {
        <form class="operations-form mfa-scan" (ngSubmit)="enable()">
          <ol>
            <li>Open your authenticator app and add an account.</li>
            <li>Scan this code, or type the key instead.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <div class="mfa-qr">
            <img [src]="s.qr" width="180" height="180" alt="QR code for your authenticator app" />
            <div>
              <small>Key</small>
              <code class="mfa-key">{{ grouped(s.secret) }}</code>
              <a class="text-button" [href]="s.uri">Open in an authenticator app on this device</a>
            </div>
          </div>
          <label class="field"><span>6-digit code</span>
            <input name="code" [(ngModel)]="code" required inputmode="numeric" pattern="[0-9 ]{6,7}" autocomplete="one-time-code" maxlength="7" placeholder="123 456" /></label>
          <div class="modal-actions">
            <button class="secondary" type="button" (click)="close()">Cancel</button>
            <button class="primary" type="submit" [disabled]="busy() || !code">Turn on</button>
          </div>
        </form>
      }
    }
    @case ('codes') {
      <div class="mfa-codes">
        <p><strong>Save these recovery codes now.</strong> Each one signs you in once if you lose your phone. They won’t be shown again.</p>
        <ul>@for (c of recoveryCodes(); track c) { <li><code>{{ c }}</code></li> }</ul>
        <div class="modal-actions">
          <button class="secondary" type="button" (click)="copy()">{{ copied() ? 'Copied' : 'Copy' }}</button>
          <a class="secondary button-link" [href]="download()" download="rentflow-recovery-codes.txt">Download</a>
          <button class="primary" type="button" (click)="close()">I’ve saved them</button>
        </div>
      </div>
    }
    @case ('disable') {
      <form class="operations-form" (ngSubmit)="change('disable')">
        <p>Turning this off means your password alone signs you in.</p>
        <ng-container *ngTemplateOutlet="confirm" />
      </form>
    }
    @case ('regenerate') {
      <form class="operations-form" (ngSubmit)="change('regenerate')">
        <p>Your old recovery codes stop working.</p>
        <ng-container *ngTemplateOutlet="confirm" />
      </form>
    }
  }
  <ng-template #confirm>
    <div class="field-row">
      <label class="field"><span>Password</span><input name="password" type="password" [(ngModel)]="password" required autocomplete="current-password" /></label>
      <label class="field"><span>Code from your app, or a recovery code</span><input name="code" [(ngModel)]="code" required autocomplete="one-time-code" maxlength="20" /></label>
    </div>
    <div class="modal-actions">
      <button class="secondary" type="button" (click)="close()">Cancel</button>
      <button class="primary" type="submit" [disabled]="busy() || !password || !code">
        {{ step() === 'disable' ? 'Turn off' : 'Create new codes' }}
      </button>
    </div>
  </ng-template>
</section>`,
  styles: `
    .mfa-actions { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
    .mfa-scan ol { margin: 0 0 var(--space-5); padding-left: 1.2em; color: var(--text-muted); line-height: 1.8; }
    .mfa-qr { display: flex; gap: var(--space-5); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-5); }
    .mfa-qr img { border-radius: 12px; background: #fff; padding: 8px; border: 1px solid var(--border); }
    .mfa-qr div { display: grid; gap: var(--space-2); min-width: 0; }
    .mfa-key { font-size: var(--text-md); letter-spacing: 0.06em; word-break: break-all; }
    .mfa-codes ul { display: grid; grid-template-columns: repeat(2, minmax(0, max-content)); gap: var(--space-2) var(--space-6); margin: var(--space-4) 0 var(--space-5); padding: 0; list-style: none; }
    .mfa-codes code { font-size: var(--text-md); }
  `,
})
export class MfaSettingsComponent {
  private readonly api = inject(ApiClient);
  protected readonly enabled = computed(() => Boolean(this.api.profile()?.user.mfaEnabled));
  protected readonly step = signal<Step>('idle');
  protected readonly setup = signal<Setup | null>(null);
  protected readonly recoveryCodes = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly copied = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected password = '';
  protected code = '';

  protected open(step: Step): void {
    this.close();
    this.notice.set('');
    this.step.set(step);
  }

  protected close(): void {
    this.step.set('idle');
    this.setup.set(null);
    this.recoveryCodes.set([]);
    this.password = this.code = '';
    this.error.set('');
    this.copied.set(false);
  }

  protected grouped(secret: string): string {
    return secret.replace(/(.{4})/g, '$1 ').trim();
  }

  protected start(): void {
    this.run(this.api.post<Setup>('/auth/mfa/setup', { password: this.password }), (setup) => {
      this.password = '';
      this.setup.set(setup);
      this.step.set('scan');
    });
  }

  protected enable(): void {
    this.run(this.api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: this.code }), (result) => {
      this.code = '';
      this.setup.set(null);
      this.recoveryCodes.set(result.recoveryCodes);
      this.step.set('codes');
      this.notice.set('Two-step sign-in is on. Your other devices were signed out.');
      this.api.me().subscribe();
    });
  }

  protected change(kind: 'disable' | 'regenerate'): void {
    const body = { password: this.password, code: this.code };
    if (kind === 'disable')
      this.run(this.api.post<void>('/auth/mfa/disable', body), () => {
        this.close();
        this.notice.set('Two-step sign-in is off.');
        this.api.me().subscribe();
      });
    else
      this.run(this.api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', body), (result) => {
        this.password = this.code = '';
        this.recoveryCodes.set(result.recoveryCodes);
        this.step.set('codes');
      });
  }

  protected copy(): void {
    void navigator.clipboard?.writeText(this.recoveryCodes().join('\n')).then(() => this.copied.set(true));
  }

  protected download(): string {
    const text = ['RentFlow recovery codes', `Account: ${this.api.profile()?.user.email ?? ''}`, '', ...this.recoveryCodes(), '', 'Each code works once.'].join('\n');
    return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  }

  private run<T>(request: Observable<T>, done: (result: T) => void): void {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: (result) => {
        this.busy.set(false);
        done(result);
      },
      error: (error: ApiError) => {
        this.busy.set(false);
        if (error.code === 'MFA_SETUP_REQUIRED') this.close();
        this.error.set(error.message);
      },
    });
  }
}
