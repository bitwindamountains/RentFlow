import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ApiClient } from '../core/api-client.service';
import type { Dashboard, Profile } from '../core/models';
import { PaymentLauncher } from '../core/payment-launcher.service';
import { DashboardPage } from './dashboard.page';

const summary = (overrides: Partial<Dashboard> = {}): Dashboard =>
  ({
    asOf: '2026-11-20',
    currency: 'PHP',
    month: '2026-11',
    billedThisMonth: '52000.00',
    collectedThisMonth: '45000.00',
    collectionRate: 86.5,
    remainingThisMonth: '7000.00',
    outstanding: '21500.00',
    overdue: '21500.00',
    activeLeases: 5,
    occupiedUnits: 5,
    totalUnits: 6,
    occupancyRate: 83.3,
    leasesEndingSoon: 1,
    openMaintenance: 1,
    topArrears: [
      { leaseId: 'lease-liza', tenantId: 'liza', tenantName: 'Liza Garcia', phone: null, unitNumber: '102', propertyName: 'Sampaguita', overdue: '14000.00', oldestDueDate: '2026-10-05', daysOverdue: 46, chargeCount: 2 },
    ],
    trend: [],
    ...overrides,
  }) as Dashboard;

async function render(options: { demo: boolean; data?: Dashboard }) {
  await TestBed.configureTestingModule({ imports: [DashboardPage], providers: [provideRouter([]), provideHttpClient()] }).compileComponents();
  const api = TestBed.inject(ApiClient);
  api.profile.set({
    user: { id: 'u', email: 'owner@example.com', name: 'Owner', emailVerified: true },
    organization: { id: 'o', name: 'Demo Rentals', slug: 'demo', currency: 'PHP', timezone: 'Asia/Manila', demoExpiresAt: options.demo ? '2099-01-01T00:00:00Z' : null },
    role: 'OWNER',
    csrfToken: 'c',
    sessionExpiresAt: '2099-01-01T00:00:00Z',
    workspaces: [],
  } as unknown as Profile);
  vi.spyOn(api, 'get').mockImplementation(((path: string) => of(path === '/dashboard' ? (options.data ?? summary()) : [])) as never);
  const fixture = TestBed.createComponent(DashboardPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, element: fixture.nativeElement as HTMLElement };
}

describe('dashboard', () => {
  it('a demo suggests collecting the top overdue balance', async () => {
    const { element } = await render({ demo: true });
    const open = vi.spyOn(TestBed.inject(PaymentLauncher), 'open').mockImplementation(() => undefined);
    const hint = element.querySelector('.demo-hint');
    expect(hint?.textContent).toContain('Try it: collect Liza Garcia’s');
    (hint!.querySelector('button') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith('lease-liza');
  });

  it('a demo hides Guided setup', async () => {
    const { element } = await render({ demo: true });
    expect(element.textContent).not.toContain('Guided setup');
  });

  it('a real workspace keeps Guided setup and shows no demo hint', async () => {
    const { element } = await render({ demo: false });
    expect(element.textContent).toContain('Guided setup');
    expect(element.querySelector('.demo-hint')).toBeNull();
  });

  it('the overdue note does not repeat the overdue amount', async () => {
    const { element } = await render({ demo: false });
    expect(element.querySelector('.tile-overdue .tile-note')?.textContent).toContain('Past due, across all months');
  });

  it('the overdue note shows the total when some of it is not yet due', async () => {
    const { element } = await render({ demo: false, data: summary({ outstanding: '28500.00' }) });
    expect(element.querySelector('.tile-overdue .tile-note')?.textContent).toContain('28,500.00 outstanding in all');
  });
});
