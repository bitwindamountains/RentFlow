import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { App } from './app';
import { routes } from './app.routes';
import { ApiClient } from './core/api-client.service';
import type { Profile } from './core/models';

const profile = (role: Profile['role']): Profile =>
  ({
    user: { id: 'user', email: 'owner@example.com', name: 'Owner', emailVerified: true },
    organization: { id: 'org', name: 'Santos Rentals', slug: 'santos', currency: 'PHP', timezone: 'Asia/Manila' },
    role,
    csrfToken: 'csrf',
    sessionExpiresAt: '2099-01-01T00:00:00Z',
    workspaces: [],
  }) as Profile;

const option = { leaseId: 'lease', tenantId: 'tenant', tenantName: 'Ana Reyes', unitNumber: '2A', propertyName: 'Sunrise', monthlyRent: '8000.00', outstanding: '100.00', balance: '100.00' };
const charges = [
  { id: 'new', leaseId: 'lease', outstanding: '50.00', dueDate: '2026-10-01', description: 'October rent' },
  { id: 'old', leaseId: 'lease', outstanding: '50.00', dueDate: '2026-09-01', description: 'September rent' },
];

describe('App shell', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), provideHttpClient()],
    }).compileComponents();
  });

  it('redirects to sign-in when there is no session', async () => {
    const api = TestBed.inject(ApiClient);
    vi.spyOn(api, 'me').mockReturnValue(throwError(() => ({ status: 401 })));
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/dashboard');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(router.url).toBe('/auth');
  });

  it('shows only the pages a role may use', async () => {
    const api = TestBed.inject(ApiClient);
    api.profile.set(profile('VIEWER'));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).querySelector('#primary-navigation')?.textContent ?? '';
    expect(text).toContain('Payments');
    expect(text).not.toContain('Staff & access');
    expect(fixture.nativeElement.textContent).not.toContain('Record payment');

    api.profile.set(profile('MAINTENANCE'));
    fixture.detectChanges();
    const maintenance = (fixture.nativeElement as HTMLElement).querySelector('#primary-navigation')?.textContent ?? '';
    expect(maintenance).toContain('Maintenance');
    expect(maintenance).not.toContain('Payments');
  });

  it('finds workspace pages and clears search with Escape', async () => {
    TestBed.inject(ApiClient).profile.set(profile('OWNER'));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector('.search input') as HTMLInputElement;
    input.value = 'pay';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(element.querySelector('.navigation-results')?.textContent).toContain('Payments');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(element.querySelector('.navigation-results')).toBeNull();
  });

  it('allocates oldest first in exact centavos and retries an uncertain payment with the same key', () => {
    const api = TestBed.inject(ApiClient);
    api.profile.set(profile('COLLECTOR'));
    vi.spyOn(api, 'get').mockImplementation(((path: string) =>
      of(path === '/collections/options' ? [option] : charges)) as never);
    const post = vi
      .spyOn(api, 'post')
      .mockReturnValueOnce(throwError(() => ({ status: 0, code: 'OFFLINE', message: 'offline' })))
      .mockReturnValueOnce(of({ id: 'payment', receiptNumber: 'SR-2026-000001', amount: '75.00', tenantName: 'Ana Reyes' }));
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as any;
    app.startPayment('lease');
    expect(app.paymentStep()).toBe(2);
    app.paymentAmount = '75.10';
    app.paymentStep.set(3);
    app.confirmPayment();
    expect(app.paymentRetryPending()).toBe(true);

    // Simulate a reload: a new component recovers the pending request from this tab.
    fixture.destroy();
    const recovered = TestBed.createComponent(App).componentInstance as any;
    recovered.startPayment();
    expect(recovered.paymentRetryPending()).toBe(true);
    recovered.confirmPayment();
    expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
    expect((post.mock.calls[0][1] as any).allocations).toEqual([
      { chargeId: 'old', amount: '50.00' },
      { chargeId: 'new', amount: '25.10' },
    ]);
    expect(recovered.paymentComplete()?.receiptNumber).toBe('SR-2026-000001');
    expect(sessionStorage.length).toBe(0);
  });

  it('does not send a payment when browser storage fails', () => {
    const api = TestBed.inject(ApiClient);
    api.profile.set(profile('OWNER'));
    vi.spyOn(api, 'get').mockImplementation(((path: string) => of(path === '/collections/options' ? [option] : charges)) as never);
    const post = vi.spyOn(api, 'post');
    const app = TestBed.createComponent(App).componentInstance as any;
    app.startPayment('lease');
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    app.paymentAmount = '10.00';
    app.confirmPayment();
    expect(post).not.toHaveBeenCalled();
    expect(app.paymentError()).toContain('not sent');
    storage.mockRestore();
  });

  it("never restores another account's pending payment", () => {
    const api = TestBed.inject(ApiClient);
    api.profile.set({ ...profile('OWNER'), user: { ...profile('OWNER').user, id: 'other-user' } });
    sessionStorage.setItem(
      'rentflow.pending-payment:org:user',
      JSON.stringify({ key: 'original', body: { tenantId: 'tenant', leaseId: 'lease', amount: '10.00', paidAt: 'x', method: 'CASH', allocations: [] } }),
    );
    vi.spyOn(api, 'get').mockReturnValue(of([]));
    const app = TestBed.createComponent(App).componentInstance as any;
    app.startPayment();
    expect(app.paymentRetryPending()).toBe(false);
  });

  it('rejects future payment dates before sending', () => {
    const api = TestBed.inject(ApiClient);
    api.profile.set(profile('OWNER'));
    vi.spyOn(api, 'get').mockImplementation(((path: string) => of(path === '/collections/options' ? [option] : charges)) as never);
    const app = TestBed.createComponent(App).componentInstance as any;
    app.startPayment('lease');
    app.paymentAmount = '10.00';
    app.paymentDate = '2999-01-01';
    app.nextPaymentStep();
    expect(app.paymentStep()).toBe(2);
    expect(app.paymentError()).toContain('future');
  });
});
