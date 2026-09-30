import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ApiClient } from '../core/api-client.service';
import { InvitePage } from './invite.page';

describe('invitation acceptance', () => {
  beforeEach(async () => {
    history.replaceState(null, '', '/accept-invite#token=invitation-token-value-123');
    await TestBed.configureTestingModule({
      imports: [InvitePage],
      providers: [provideHttpClient(), provideRouter([])],
    }).compileComponents();
  });

  it('reads the token from the fragment, removes it from the URL, and signs in to the invited workspace', () => {
    const fixture = TestBed.createComponent(InvitePage);
    const page = fixture.componentInstance as any;
    expect(window.location.hash).toBe('');
    const api = TestBed.inject(ApiClient);
    const accept = vi
      .spyOn(api, 'publicPost')
      .mockReturnValue(of({ accepted: true, email: 'member@example.com', workspace: 'rentflow-demo' }));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    page.existingAccount.set(true);
    page.password = 'current password';
    page.accept();
    expect(accept).toHaveBeenCalledWith('/staff/invitations/accept', {
      token: 'invitation-token-value-123',
      password: 'current password',
    });
    expect(navigate).toHaveBeenCalledWith(['/auth'], {
      queryParams: { email: 'member@example.com', workspace: 'rentflow-demo', invited: '1' },
      replaceUrl: true,
    });
  });

  it('switches to the existing-account form when the email already has an account', () => {
    const fixture = TestBed.createComponent(InvitePage);
    const page = fixture.componentInstance as any;
    vi.spyOn(TestBed.inject(ApiClient), 'publicPost').mockReturnValue(
      throwError(() => ({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Use your existing RentFlow password.' })),
    );
    page.name = 'New Person';
    page.password = 'a long new password';
    page.accept();
    expect(page.existingAccount()).toBe(true);
    expect(page.error()).toContain('existing');
  });
});
