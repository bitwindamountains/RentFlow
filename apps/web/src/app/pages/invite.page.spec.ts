import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ApiClient } from '../core/api-client.service';
import { InvitePage } from './invite.page';

describe('invitation acceptance', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InvitePage],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap({ token: 'invitation-token' }) },
          },
        },
      ],
    }).compileComponents();
  });

  it('uses the current password and carries the invited workspace into sign-in', () => {
    const fixture = TestBed.createComponent(InvitePage);
    const page = fixture.componentInstance as any;
    const api = TestBed.inject(ApiClient);
    const accept = vi
      .spyOn(api, 'acceptInvitation')
      .mockReturnValue(
        of({ accepted: true, email: 'member@example.test', workspace: 'rental-team' }),
      );
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    page.existingAccount.set(true);
    page.password = 'current-password';
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[name="name"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('input[name="password"]').getAttribute('autocomplete'),
    ).toBe('current-password');
    page.accept();
    expect(accept).toHaveBeenCalledWith({
      token: 'invitation-token',
      password: 'current-password',
    });
    expect(navigate).toHaveBeenCalledWith(['/auth'], {
      queryParams: { email: 'member@example.test', workspace: 'rental-team', invited: '1' },
      replaceUrl: true,
    });
    expect(page.password).toBe('');
  });

  it('keeps the invitation available after an incorrect password', () => {
    const page = TestBed.createComponent(InvitePage).componentInstance as any;
    vi.spyOn(TestBed.inject(ApiClient), 'acceptInvitation').mockReturnValue(
      throwError(() => ({ status: 401, error: { message: 'Use the existing account password.' } })),
    );
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    page.existingAccount.set(true);
    page.password = 'wrong-password';
    page.accept();
    expect(navigate).not.toHaveBeenCalled();
    expect(page.saving()).toBe(false);
    expect(page.error()).toContain('existing account password');
  });
});
