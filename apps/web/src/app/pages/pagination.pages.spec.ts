import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MaintenancePage } from './maintenance.page';
import { PortalDocumentsPage } from './portal-documents.page';
import { PortalPaymentsPage } from './portal-payments.page';

describe('history pagination controls', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MaintenancePage, PortalDocumentsPage, PortalPaymentsPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const document = (id: string) => ({ id, name: `Document ${id}`, category: 'Lease', kind: 'link', url: 'https://example.com/file', createdAt: '2025-01-01T00:00:00.000Z' });
  const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')].find(node => node.textContent?.includes(text))!;

  it('retains documents and the next cursor after an error, then appends a retry without duplicates', () => {
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PortalDocumentsPage);
    fixture.detectChanges();
    http.expectOne(req => req.url.endsWith('/portal/documents')).flush([document('one')], { headers: { 'x-next-cursor': 'page-two' } });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Load more documents').click();
    fixture.detectChanges();
    expect(button(root, 'Loading').disabled).toBe(true);
    http.expectOne(req => req.params.get('cursor') === 'page-two').flush({ code: 'STORAGE_UNAVAILABLE', message: 'Try again' }, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(root.querySelectorAll('.attention-item')).toHaveLength(1);
    button(root, 'Load more documents').click();
    http.expectOne(req => req.params.get('cursor') === 'page-two').flush([document('one'), document('two')], { headers: { 'x-next-cursor': '' } });
    fixture.detectChanges();
    expect(root.querySelectorAll('.attention-item')).toHaveLength(2);
    expect(root.textContent).toContain('Document two');
    expect(button(root, 'Load more')).toBeUndefined();
  });

  it('ignores an older maintenance response after the filter changes', () => {
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(MaintenancePage);
    fixture.detectChanges();
    const active = http.expectOne(req => req.url.endsWith('/maintenance') && req.params.get('status') === 'active');
    http.expectOne(req => req.url.endsWith('/properties')).flush([]);
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Closed').click();
    const work = { id: 'closed', title: 'Completed repair', propertyName: 'Home', description: 'Fixed', priority: 'LOW', status: 'COMPLETED', createdAt: '2025-01-01T00:00:00.000Z' };
    http.expectOne(req => req.params.get('status') === 'closed').flush([work]);
    active.flush([{ ...work, id: 'open', title: 'Outdated open response', status: 'OPEN' }]);
    fixture.detectChanges();
    expect(root.textContent).toContain('Completed repair');
    expect(root.textContent).not.toContain('Outdated open response');
  });

  it('loads older payment reports without replacing the separate payment history', () => {
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PortalPaymentsPage);
    fixture.detectChanges();
    http.expectOne(req => req.url.endsWith('/portal/home')).flush({ organization: { name: 'Home', currency: 'PHP' }, leases: [], balance: { outstanding: '0.00' } });
    const payment = { id: 'payment-one', amount: '10.00', method: 'CASH', paidAt: '2025-01-01T00:00:00.000Z', status: 'POSTED', receiptNumber: 'R-1' };
    const notice = { id: 'notice-one', amount: '10.00', method: 'CASH', paidOn: '2025-01-01', status: 'WITHDRAWN' };
    http.expectOne(req => req.url.endsWith('/portal/payments')).flush({ payments: [payment], notices: [notice], paymentsNextCursor: 'older-payments', noticesNextCursor: 'older-notices' });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Load more reports').click();
    http.expectOne(req => req.params.get('noticesCursor') === 'older-notices').flush({ payments: [], notices: [{ ...notice, id: 'notice-two', amount: '20.00' }], paymentsNextCursor: null, noticesNextCursor: null });
    fixture.detectChanges();
    expect(root.textContent).toContain('R-1');
    expect(root.querySelectorAll('.attention-item')).toHaveLength(3);
    button(root, 'Load more payments').click();
    http.expectOne(req => req.params.get('paymentsCursor') === 'older-payments').flush({ payments: [{ ...payment, id: 'payment-two', receiptNumber: 'R-2' }], notices: [], paymentsNextCursor: null, noticesNextCursor: null });
    fixture.detectChanges();
    expect(root.querySelectorAll('.attention-item')).toHaveLength(4);
    expect(root.textContent).toContain('R-2');
    expect(button(root, 'Load more')).toBeUndefined();
  });
});
