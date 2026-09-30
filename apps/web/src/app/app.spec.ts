import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { ApiClient } from './core/api-client.service';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';

describe('App', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the product navigation', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('RentFlow');
    expect(compiled.textContent).toContain('Properties');
    expect(compiled.textContent).toContain('Deposits');
    expect(compiled.textContent).not.toContain('Record payment');
  });

  it('protects the dashboard route with authentication', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/dashboard');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(router.url).toBe('/auth');
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain(
      'Know what’s happening in every unit.',
    );
  });

  it('finds workspace pages and clears search with Escape', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector('.search input') as HTMLInputElement;
    input.value = 'pay';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(element.querySelector('.navigation-results')?.textContent).toContain('Payments');
    expect(element.querySelector('.navigation-results')?.textContent).not.toContain('Properties');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(element.querySelector('.navigation-results')).toBeNull();
  });

  it('opens the full menu from the mobile More button', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('.mobile-nav button') as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('retries an uncertain payment with the same key and payload and allocates oldest first', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as any;
    const api = TestBed.inject(ApiClient);
    api.profile.set({ user: { id: 'user' }, organization: { id: 'org' }, role: 'OWNER' } as any);
    const post = vi
      .spyOn(api, 'post')
      .mockReturnValueOnce(throwError(() => ({ status: 0 })))
      .mockReturnValueOnce(of({ receiptNumber: 'TEST-1' }));
    app.selectedTenantId = 'tenant';
    app.selectedLeaseId = 'lease';
    app.paymentAmount = '75.00';
    app.paymentCharges.set([
      { id: 'new', leaseId: 'lease', outstanding: '50.00', dueDate: '2026-10-01' },
      { id: 'old', leaseId: 'lease', outstanding: '50.00', dueDate: '2026-09-01' },
    ]);
    app.confirmPayment();
    expect(app.paymentRetryPending()).toBe(true);
    // Recreate the component to simulate a browser reload, losing all in-memory state.
    fixture.destroy();
    const recovered = TestBed.createComponent(App).componentInstance as any;
    recovered.startPayment();
    expect(recovered.paymentRetryPending()).toBe(true);
    recovered.confirmPayment();
    expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
    expect((post.mock.calls[0][1] as any).allocations).toEqual([
      { chargeId: 'old', amount: '50.00' },
      { chargeId: 'new', amount: '25.00' },
    ]);
    expect(recovered.paymentRetryPending()).toBe(false);
    expect(recovered.paymentComplete()).toBe(true);
    expect(sessionStorage.length).toBe(0);
  });

  it('does not send a payment when browser storage fails', () => {
    const app = TestBed.createComponent(App).componentInstance as any;
    const api = TestBed.inject(ApiClient);
    api.profile.set({ user: { id: 'user' }, organization: { id: 'org' } } as any);
    const post = vi.spyOn(api, 'post');
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    app.selectedTenantId = 'tenant';
    app.selectedLeaseId = 'lease';
    app.paymentAmount = '10.00';
    app.confirmPayment();
    expect(post).not.toHaveBeenCalled();
    expect(app.paymentLoading()).toBe(false);
    expect(app.paymentError()).toContain('not sent');
    storage.mockRestore();
  });

  it("does not restore another account's pending payment", () => {
    const app = TestBed.createComponent(App).componentInstance as any;
    const api = TestBed.inject(ApiClient);
    api.profile.set({ user: { id: 'other-user' }, organization: { id: 'org' } } as any);
    sessionStorage.setItem(
      'rentflow.pending-payment:org:user',
      JSON.stringify({
        key: 'original',
        body: { tenantId: 'tenant', leaseId: 'lease', amount: '10.00', allocations: [] },
      }),
    );
    vi.spyOn(api, 'get').mockReturnValue(of([]));
    app.startPayment();
    expect(app.paymentRetryPending()).toBe(false);
    expect(app.paymentRequest).toBeUndefined();
  });
});
