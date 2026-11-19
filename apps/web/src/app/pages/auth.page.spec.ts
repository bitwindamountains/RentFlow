import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ApiClient } from '../core/api-client.service';
import type { Profile } from '../core/models';
import { AuthPage } from './auth.page';

async function render(options: { enabled: boolean; query?: Record<string, string> }) {
  await TestBed.configureTestingModule({
    imports: [AuthPage],
    providers: [
      provideHttpClient(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(options.query ?? {}) } } },
    ],
  }).compileComponents();
  const api = TestBed.inject(ApiClient);
  vi.spyOn(api, 'publicGet').mockReturnValue(of({ enabled: options.enabled }));
  const fixture = TestBed.createComponent(AuthPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const demoButton = () => [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('Try the demo'));
  return { api, fixture, element, demoButton };
}

describe('sign-in page demo', () => {
  it('hides the demo button when demo mode is off', async () => {
    const { demoButton } = await render({ enabled: false });
    expect(demoButton()).toBeUndefined();
  });

  it('starts a demo and goes to the dashboard', async () => {
    const { api, fixture, demoButton } = await render({ enabled: true });
    const session = vi.spyOn(api, 'session').mockReturnValue(of({ role: 'OWNER' } as Profile));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    expect(fixture.nativeElement.textContent).toContain('No sign-up. A private sample workspace, deleted after 24 hours.');
    demoButton()!.click();
    expect(session).toHaveBeenCalledWith('/demo', {});
    expect(navigate).toHaveBeenCalledWith('/dashboard');
  });

  it('shows the busy message on 503', async () => {
    const { api, fixture, element, demoButton } = await render({ enabled: true });
    vi.spyOn(api, 'session').mockReturnValue(throwError(() => ({ status: 503, code: 'DEMO_UNAVAILABLE', message: 'x' })));
    demoButton()!.click();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'The demo is busy right now. Try again in a little while, or create your own workspace.',
    );
  });

  it('shows a demo error under the demo button, not in the sign-in form', async () => {
    const { api, fixture, element, demoButton } = await render({ enabled: true });
    vi.spyOn(api, 'session').mockReturnValue(throwError(() => ({ status: 0, code: 'NETWORK', message: 'Cannot reach RentFlow. Check your connection and try again.' })));
    demoButton()!.click();
    fixture.detectChanges();
    expect(element.querySelector('.auth-demo [role="alert"]')?.textContent).toContain('Cannot reach RentFlow');
    expect(element.querySelectorAll('[role="alert"]').length).toBe(1);
  });

  it('opens in register mode with ?register=1', async () => {
    const { element } = await render({ enabled: true, query: { register: '1' } });
    expect(element.querySelector('h2')?.textContent).toContain('Create your account');
  });
});
