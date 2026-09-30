import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ApiClient, isUncertain, type ApiError } from './core/api-client.service';
import { AppUpdate } from './core/app-update.service';
import { LabelPipe, MoneyPipe } from './core/format';
import type { Charge, CollectionOption, Payment, Role } from './core/models';
import { allocateOldestFirst, fromCents, isMoney, sumCents, toCents } from './core/money';
import { PaymentLauncher } from './core/payment-launcher.service';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface NavItem {
  label: string;
  route: string;
  roles: Role[];
  section?: string;
}

interface PendingPayment {
  key: string;
  body: {
    tenantId: string;
    leaseId: string;
    amount: string;
    method: string;
    referenceNumber?: string;
    paidAt: string;
    allocations: Array<{ chargeId: string; amount: string }>;
  };
}

const FINANCE: Role[] = ['OWNER', 'MANAGER', 'COLLECTOR', 'VIEWER'];

@Component({
  selector: 'app-root',
  imports: [FormsModule, RouterLink, RouterLinkActive, RouterOutlet, MoneyPipe, LabelPipe],
  styleUrl: './app.scss',
  templateUrl: './app.html',
  encapsulation: ViewEncapsulation.None,
})
export class App {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly launcher = inject(PaymentLauncher);
  protected readonly update = inject(AppUpdate);
  protected readonly profile = this.api.profile;
  protected readonly online = this.api.online;
  @ViewChild('globalSearch') private searchInput?: ElementRef<HTMLInputElement>;

  protected readonly navItems: NavItem[] = [
    { label: 'Dashboard', route: '/dashboard', roles: FINANCE, section: 'Workspace' },
    { label: 'Properties', route: '/properties', roles: FINANCE },
    { label: 'Tenants', route: '/tenants', roles: FINANCE },
    { label: 'Leases', route: '/leases', roles: FINANCE },
    { label: 'Billing', route: '/billing', roles: FINANCE, section: 'Money' },
    { label: 'Payments', route: '/payments', roles: FINANCE },
    { label: 'Deposits', route: '/deposits', roles: FINANCE },
    { label: 'Expenses', route: '/expenses', roles: FINANCE },
    { label: 'Reports', route: '/reports', roles: FINANCE },
    { label: 'Maintenance', route: '/maintenance', roles: [...FINANCE, 'MAINTENANCE'], section: 'Operations' },
    { label: 'Documents', route: '/documents', roles: FINANCE },
    { label: 'Reminders', route: '/reminders', roles: FINANCE },
    { label: 'Staff & access', route: '/staff', roles: ['OWNER'] },
    { label: 'Account', route: '/account', roles: [...FINANCE, 'MAINTENANCE'] },
  ];
  protected readonly navigationIcons: Record<string, string> = {
    '/dashboard': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    '/properties': 'M4 21V3h12v18 M16 9h4v12 M8 7h4 M8 11h4 M8 15h4 M9 21v-3h3v3',
    '/tenants': 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4',
    '/leases': 'M14 2H5v20h14V7z M14 2v5h5 M8 12h8 M8 16h6',
    '/billing': 'M5 3h14v18l-3-2-4 2-4-2-3 2z M8 7h8 M8 11h8 M8 15h4',
    '/payments': 'M3 6h18v14H3z M3 10h18 M7 15h4',
    '/deposits': 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z M8 12l3 3 5-6',
    '/expenses': 'M3 6h16v14H3z M3 6V3h13v3 M15 11h6v5h-6z',
    '/maintenance': 'M14 6a5 5 0 0 0-6 6L2 18l4 4 6-6a5 5 0 0 0 6-6l-4 2-3-3z',
    '/documents': 'M3 5h7l2 3h9v12H3z',
    '/reminders': 'M18 8a6 6 0 0 0-12 0v5l-2 4h16l-2-4z M10 21h4',
    '/reports': 'M4 3v18h17 M8 17v-5 M13 17V7 M18 17V4',
    '/staff': 'M12 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2',
    '/account': 'M12 2a5 5 0 1 0 0 10a5 5 0 0 0 0-10 M3 22a9 9 0 0 1 18 0',
  };
  protected readonly visibleNav = computed(() => {
    const role = this.profile()?.role;
    return this.navItems.filter((item) => role && item.roles.includes(role));
  });
  protected readonly mobileNav = computed(() => {
    const role = this.profile()?.role;
    if (role === 'MAINTENANCE') return this.navItems.filter((item) => ['/maintenance', '/account'].includes(item.route));
    return this.navItems.filter((item) => ['/dashboard', '/tenants', '/billing', '/payments'].includes(item.route));
  });

  protected readonly menuOpen = signal(false);
  protected readonly navigationQuery = signal('');
  protected readonly navigationMatches = computed(() => {
    const query = this.navigationQuery().trim().toLowerCase();
    return query ? this.visibleNav().filter((item) => item.label.toLowerCase().includes(query)) : [];
  });
  protected readonly authScreen = signal(this.isPublicPath(window.location.pathname));
  protected readonly installReady = signal(false);
  protected readonly toast = signal('');
  private installPrompt?: InstallPromptEvent;

  // ----- Record payment sheet -----
  protected readonly paymentOpen = signal(false);
  protected readonly paymentStep = signal(1);
  protected readonly paymentComplete = signal<Payment | null>(null);
  protected readonly paymentLoading = signal(false);
  protected readonly paymentError = signal('');
  protected readonly paymentRetryPending = signal(false);
  protected readonly options = signal<CollectionOption[]>([]);
  protected readonly openCharges = signal<Charge[]>([]);
  protected readonly optionQuery = signal('');
  protected readonly filteredOptions = computed(() => {
    const q = this.optionQuery().trim().toLowerCase();
    return this.options()
      .filter((o) => `${o.tenantName} ${o.propertyName} ${o.unitNumber}`.toLowerCase().includes(q))
      .sort((a, b) => toCents(b.outstanding) - toCents(a.outstanding) || a.tenantName.localeCompare(b.tenantName));
  });
  protected selectedLeaseId = '';
  protected paymentAmount = '';
  protected paymentMethod = 'GCASH';
  protected paymentReference = '';
  protected paymentDate = '';
  private pending?: PendingPayment;
  private paymentOpener?: HTMLElement;
  private firstNavigation = true;
  protected readonly today = () => this.api.today();

  constructor() {
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.authScreen.set(this.isPublicPath(event.urlAfterRedirects));
        this.navigationQuery.set('');
        this.menuOpen.set(false);
        if (this.authScreen()) {
          this.paymentOpen.set(false);
          this.pending = undefined;
          this.toast.set('');
        }
        // Move focus to the new page heading for screen-reader and keyboard users.
        if (!this.firstNavigation)
          setTimeout(() => {
            const heading = document.querySelector<HTMLElement>('main h1');
            heading?.setAttribute('tabindex', '-1');
            heading?.focus({ preventScroll: true });
          });
        this.firstNavigation = false;
      });
    effect(() => {
      const request = this.launcher.request();
      if (request) untracked(() => this.startPayment(request.leaseId));
    });
  }

  private isPublicPath(path: string): boolean {
    return ['/auth', '/accept-invite', '/reset-password', '/verify-email'].some((prefix) => path.startsWith(prefix));
  }

  protected canRecordPayment(): boolean {
    return this.api.hasRole('OWNER', 'MANAGER', 'COLLECTOR');
  }

  @HostListener('window:online') protected wentOnline(): void {
    this.online.set(true);
  }
  @HostListener('window:offline') protected wentOffline(): void {
    this.online.set(false);
  }
  @HostListener('window:beforeinstallprompt', ['$event'])
  protected captureInstall(event: Event): void {
    event.preventDefault();
    this.installPrompt = event as InstallPromptEvent;
    this.installReady.set(!window.matchMedia('(display-mode: standalone)').matches);
  }
  protected async installApp(): Promise<void> {
    if (!this.installPrompt) return;
    await this.installPrompt.prompt();
    await this.installPrompt.userChoice;
    this.installPrompt = undefined;
    this.installReady.set(false);
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }
  protected closeMenu(): void {
    this.menuOpen.set(false);
  }
  protected openFirstMatch(): void {
    const match = this.navigationMatches()[0];
    if (match) void this.router.navigateByUrl(match.route);
  }

  @HostListener('document:keydown', ['$event'])
  protected handleKeyboard(event: KeyboardEvent): void {
    if (event.key === 'Tab' && this.paymentOpen()) {
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.payment-modal button:not(:disabled), .payment-modal input:not(:disabled), .payment-modal select:not(:disabled), .payment-modal a[href]',
        ),
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.searchInput?.nativeElement.focus();
    }
    if (event.key === 'Escape') {
      this.navigationQuery.set('');
      this.menuOpen.set(false);
      this.closePayment();
    }
  }

  // ----- Payment flow -----

  protected startPayment(leaseId?: string): void {
    if (!this.canRecordPayment()) return;
    this.paymentOpener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.paymentOpen.set(true);
    setTimeout(() => document.querySelector<HTMLButtonElement>('.payment-modal .modal-close')?.focus());
    if (this.restorePending()) return;
    this.paymentComplete.set(null);
    this.paymentError.set('');
    this.paymentStep.set(1);
    this.optionQuery.set('');
    this.paymentMethod = 'GCASH';
    this.paymentReference = '';
    this.paymentDate = this.api.today();
    this.selectedLeaseId = leaseId ?? '';
    this.paymentLoading.set(true);
    this.api.get<CollectionOption[]>('/collections/options').subscribe({
      next: (options) => {
        this.options.set(options);
        this.paymentLoading.set(false);
        if (this.selectedLeaseId) this.selectLease(this.selectedLeaseId, true);
      },
      error: (error: ApiError) => {
        this.paymentLoading.set(false);
        this.paymentError.set(error.message);
      },
    });
  }

  protected selectLease(leaseId: string, advance = false): void {
    this.selectedLeaseId = leaseId;
    this.openCharges.set([]);
    const option = this.selected();
    this.paymentAmount = option && toCents(option.outstanding) > 0 ? option.outstanding : (option?.monthlyRent ?? '');
    if (!leaseId) return;
    this.api.get<Charge[]>(`/leases/${leaseId}/open-charges`).subscribe({
      next: (charges) => {
        this.openCharges.set(charges);
        if (advance) this.paymentStep.set(2);
      },
      error: (error: ApiError) => this.paymentError.set(error.message),
    });
  }

  protected selected(): CollectionOption | undefined {
    return this.options().find((option) => option.leaseId === this.selectedLeaseId);
  }

  protected allocationPreview() {
    if (!isMoney(this.paymentAmount)) return { lines: [], credit: '0.00' };
    const allocations = allocateOldestFirst(this.paymentAmount, this.openCharges());
    const lines = allocations.map((a) => ({ ...a, charge: this.openCharges().find((c) => c.id === a.chargeId)! }));
    return { lines, credit: fromCents(toCents(this.paymentAmount) - sumCents(allocations.map((a) => a.amount))) };
  }

  protected remainingAfter(): string {
    return fromCents(toCents(this.selected()?.outstanding) - toCents(this.paymentAmount));
  }

  protected nextPaymentStep(): void {
    if (this.paymentStep() === 1 && !this.selectedLeaseId) {
      this.paymentError.set('Choose who paid.');
      return;
    }
    if (this.paymentStep() === 2) {
      if (!isMoney(this.paymentAmount)) {
        this.paymentError.set('Enter a positive amount with up to two decimal places.');
        return;
      }
      if (!this.paymentDate || this.paymentDate > this.api.today()) {
        this.paymentError.set('The payment date cannot be in the future.');
        return;
      }
    }
    this.paymentError.set('');
    this.paymentStep.update((step) => Math.min(3, step + 1));
  }

  protected previousPaymentStep(): void {
    if (this.paymentLoading() || this.paymentRetryPending()) return;
    this.paymentError.set('');
    this.paymentStep.update((step) => Math.max(1, step - 1));
  }

  protected closePayment(): void {
    if (this.paymentLoading()) return;
    this.paymentOpen.set(false);
    this.paymentOpener?.focus();
  }

  protected confirmPayment(): void {
    if (this.paymentLoading()) return;
    const option = this.selected();
    if (!this.pending) {
      if (!option || !isMoney(this.paymentAmount)) {
        this.paymentError.set('Choose who paid and enter a valid amount.');
        return;
      }
      const today = this.api.today();
      this.pending = {
        key: crypto.randomUUID(),
        body: {
          tenantId: option.tenantId,
          leaseId: option.leaseId,
          amount: fromCents(toCents(this.paymentAmount)),
          method: this.paymentMethod,
          referenceNumber: this.paymentReference.trim() || undefined,
          // Past dates are recorded at noon so they stay on that calendar day in any Philippine time.
          paidAt: this.paymentDate === today ? new Date().toISOString() : `${this.paymentDate}T04:00:00.000Z`,
          allocations: allocateOldestFirst(this.paymentAmount, this.openCharges()),
        },
      };
    }
    const request = this.pending;
    try {
      // Saved first so an uncertain result survives a reload and is retried, not re-entered.
      sessionStorage.setItem(this.storageKey(), JSON.stringify(request));
    } catch {
      this.pending = undefined;
      this.paymentError.set('Payment was not sent. Enable browser storage for this site and try again.');
      return;
    }
    this.paymentLoading.set(true);
    this.paymentError.set('');
    this.api.post<Payment>('/payments', request.body, request.key).subscribe({
      next: (payment) => {
        this.clearPending();
        this.paymentLoading.set(false);
        this.paymentComplete.set(payment);
        this.showToast(`Payment recorded. Receipt ${payment.receiptNumber}`);
      },
      error: (error: ApiError) => {
        this.paymentLoading.set(false);
        const uncertain = isUncertain(error);
        this.paymentRetryPending.set(uncertain);
        if (!uncertain && error.status !== 401) this.clearPending();
        this.paymentError.set(
          uncertain
            ? 'We could not confirm this payment. Retry — it will not be recorded twice. Do not record it again in another tab.'
            : error.message,
        );
      },
    });
  }

  private storageKey(): string {
    const profile = this.profile();
    return `rentflow.pending-payment:${profile?.organization.id}:${profile?.user.id}`;
  }

  private clearPending(): void {
    this.pending = undefined;
    this.paymentRetryPending.set(false);
    try {
      sessionStorage.removeItem(this.storageKey());
    } catch {
      /* ignore */
    }
  }

  /** Reopens an unconfirmed payment from this tab so it can be retried with its original key. */
  private restorePending(): boolean {
    let saved: PendingPayment | undefined = this.pending;
    try {
      const raw = sessionStorage.getItem(this.storageKey());
      if (!saved && raw) saved = JSON.parse(raw) as PendingPayment;
    } catch {
      saved = undefined;
    }
    if (!saved?.key || !saved.body?.leaseId) return false;
    this.pending = saved;
    this.selectedLeaseId = saved.body.leaseId;
    this.paymentAmount = saved.body.amount;
    this.paymentMethod = saved.body.method;
    this.paymentReference = saved.body.referenceNumber ?? '';
    this.paymentDate = saved.body.paidAt.slice(0, 10);
    this.paymentComplete.set(null);
    this.paymentStep.set(3);
    this.paymentRetryPending.set(true);
    this.paymentError.set('An earlier payment was not confirmed. Retry to finish recording it or to fetch its receipt.');
    this.api.get<CollectionOption[]>('/collections/options').subscribe((options) => this.options.set(options));
    return true;
  }

  protected discardPending(): void {
    if (!confirm('Discard the unconfirmed payment? Check Payments first — it may already be recorded.')) return;
    this.clearPending();
    this.startPayment();
  }

  protected showToast(message: string): void {
    this.toast.set(message);
    window.setTimeout(() => this.toast.set(''), 4500);
  }

  protected resendVerification(): void {
    this.api.post('/auth/email/resend', {}).subscribe({
      next: () => this.showToast('Verification email sent.'),
      error: (error: ApiError) => this.showToast(error.message),
    });
  }

  protected signOut(): void {
    this.api.logout().subscribe({
      next: () => void this.router.navigate(['/auth']),
      error: () => void this.router.navigate(['/auth']),
    });
  }
}
