import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, provideRouter, Router, type RouterStateSnapshot, UrlTree } from '@angular/router';
import { ApiClient } from './api-client.service';
import { authGuard } from './auth.guard';
import type { Profile } from './models';

describe('authGuard', () => {
  const run = (path: string, roles?: string[]) =>
    TestBed.runInInjectionContext(() =>
      authGuard({ routeConfig: { path }, data: { roles } } as unknown as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    );
  const signIn = (profile: Partial<Profile>) =>
    TestBed.inject(ApiClient).profile.set({ role: 'OWNER', ...profile } as Profile);
  const target = (result: unknown) => TestBed.inject(Router).serializeUrl(result as UrlTree);

  beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] }));

  it('sends an owner who must set up two-step sign-in to Account, and lets Account open', () => {
    signIn({ mfaSetupRequired: true });
    expect(target(run('dashboard', ['OWNER']))).toBe('/account');
    expect(target(run('tenants'))).toBe('/account');
    expect(run('account')).toBe(true);
  });

  it('allows routes normally once two-step sign-in is not required', () => {
    signIn({ mfaSetupRequired: false });
    expect(run('dashboard', ['OWNER'])).toBe(true);
    expect(target(run('portal', ['TENANT']))).toBe('/dashboard');
  });
});
