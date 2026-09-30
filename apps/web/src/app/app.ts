import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  ViewEncapsulation,
  inject,
  signal,
  computed,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { forkJoin } from 'rxjs';
import { ApiClient } from './core/api-client.service';

interface TenantChoice {
  id: string;
  firstName: string;
  lastName: string;
  balance: string;
}
interface LeaseChoice {
  id: string;
  tenantId: string;
  unit: { number: string };
  status: string;
}
interface ChargeChoice {
  id: string;
  leaseId: string;
  description: string;
  outstanding: string;
  dueDate: string;
}
interface PostedPayment {
  receiptNumber: string;
}
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface NavItem {
  label: string;
  icon: string;
  route: string;
  badge?: number;
}

@Component({
  selector: 'app-root',
  imports: [FormsModule, RouterLink, RouterLinkActive, RouterOutlet],
  styleUrl: './app.scss',
  templateUrl: './app.html',
  encapsulation: ViewEncapsulation.None,
})
export class App {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  protected readonly profile = this.api.profile;
  @ViewChild('globalSearch') private searchInput?: ElementRef<HTMLInputElement>;

  protected readonly menuOpen = signal(false);
  protected readonly navigationQuery = signal('');
  protected readonly navigationMatches = computed(() => {
    const query = this.navigationQuery().trim().toLowerCase();
    return query
      ? this.navItems.filter(
          (item) => this.canSee(item) && item.label.toLowerCase().includes(query),
        )
      : [];
  });
  protected readonly paymentOpen = signal(false);
  protected readonly paymentStep = signal(1);
  protected readonly paymentComplete = signal(false);
  protected readonly paymentLoading = signal(false);
  protected readonly paymentError = signal('');
  protected readonly receiptNumber = signal('');
  protected readonly paymentTenants = signal<TenantChoice[]>([]);
  protected readonly paymentLeases = signal<LeaseChoice[]>([]);
  protected readonly paymentCharges = signal<ChargeChoice[]>([]);
  protected readonly toast = signal('');
  protected readonly authScreen = signal(
    ['/auth', '/accept-invite'].includes(window.location.pathname),
  );
  protected readonly online = signal(navigator.onLine);
  protected readonly installReady = signal(false);
  private installPrompt?: InstallPromptEvent;
  private paymentRequest?: { key: string; body: object };
  private paymentRecoveryBlocked = false;
  private paymentOpener?: HTMLElement;
  protected readonly paymentRetryPending = signal(false);

  protected selectedTenantId = '';
  protected selectedLeaseId = '';
  protected paymentAmount = '';
  protected paymentMethod = 'GCASH';
  protected paymentReference = '';

  constructor() {
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.authScreen.set(
          event.urlAfterRedirects.startsWith('/auth') ||
            event.urlAfterRedirects.startsWith('/accept-invite'),
        );
        this.navigationQuery.set('');
        this.closeMenu();
        if (this.authScreen()) {
          this.paymentOpen.set(false);
          this.paymentRequest = undefined;
          this.paymentRetryPending.set(false);
          this.paymentTenants.set([]);
          this.paymentLeases.set([]);
          this.paymentCharges.set([]);
          this.toast.set('');
        }
      });
  }

  protected readonly navItems: NavItem[] = [
    { label: 'Dashboard', icon: 'D', route: '/dashboard' },
    { label: 'Properties', icon: 'P', route: '/properties' },
    { label: 'Tenants', icon: 'T', route: '/tenants' },
    { label: 'Leases', icon: 'L', route: '/leases' },
    { label: 'Billing', icon: 'B', route: '/billing' },
    { label: 'Payments', icon: '$', route: '/payments' },
    { label: 'Deposits', icon: 'S', route: '/deposits' },
    { label: 'Expenses', icon: 'E', route: '/expenses' },
    { label: 'Maintenance', icon: 'M', route: '/maintenance' },
    { label: 'Documents', icon: 'F', route: '/documents' },
    { label: 'Reminders', icon: '!', route: '/reminders' },
    { label: 'Reports', icon: 'R', route: '/reports' },
    { label: 'Staff & access', icon: 'A', route: '/staff' },
  ];
  protected readonly navigationIcons: Record<string, string> = {
    '/dashboard': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    '/properties': 'M4 21V3h12v18 M16 9h4v12 M8 7h4 M8 11h4 M8 15h4 M9 21v-3h3v3',
    '/tenants':
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4',
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
  };

  protected readonly mobileNav: NavItem[] = [
    { label: 'Home', icon: '⌂', route: '/dashboard' },
    { label: 'Properties', icon: '▦', route: '/properties' },
    { label: 'Tenants', icon: '♙', route: '/tenants' },
    { label: 'Payments', icon: '↙', route: '/payments' },
    { label: 'More', icon: '•••', route: '/reminders' },
  ];

  protected canSee(item: NavItem): boolean {
    if (this.profile()?.role === 'MAINTENANCE') return item.route === '/maintenance';
    return item.route !== '/staff' || this.profile()?.role === 'OWNER';
  }
  protected openFirstMatch(): void {
    const match = this.navigationMatches()[0];
    if (match) void this.router.navigateByUrl(match.route);
  }
  protected canRecordPayment(): boolean {
    return ['OWNER', 'MANAGER', 'COLLECTOR'].includes(this.profile()?.role ?? '');
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
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
    this.installReady.set(true);
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

  protected startPayment(): void {
    if (!this.restorePayment()) return;
    this.paymentOpener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    window.setTimeout(() =>
      document.querySelector<HTMLButtonElement>('.payment-modal .modal-close')?.focus(),
    );
    if (this.paymentRetryPending()) {
      this.paymentOpen.set(true);
      return;
    }
    this.paymentRequest = undefined;
    this.paymentStep.set(1);
    this.paymentComplete.set(false);
    this.paymentError.set('');
    this.paymentOpen.set(true);
    this.paymentLoading.set(true);
    forkJoin({
      tenants: this.api.get<TenantChoice[]>('/tenants'),
      leases: this.api.get<LeaseChoice[]>('/leases'),
      charges: this.api.get<ChargeChoice[]>('/charges'),
    }).subscribe({
      next: ({ tenants, leases, charges }) => {
        this.paymentTenants.set(tenants);
        this.paymentLeases.set(leases.filter((lease) => lease.status === 'ACTIVE'));
        this.paymentCharges.set(charges.filter((charge) => Number(charge.outstanding) > 0));
        this.selectedTenantId =
          tenants.find((tenant) =>
            leases.some((lease) => lease.tenantId === tenant.id && lease.status === 'ACTIVE'),
          )?.id ?? '';
        this.selectTenant();
        this.paymentLoading.set(false);
      },
      error: () => {
        this.paymentError.set('Payment options could not be loaded.');
        this.paymentLoading.set(false);
      },
    });
  }

  protected selectTenant(): void {
    this.selectedLeaseId =
      this.paymentLeases().find((lease) => lease.tenantId === this.selectedTenantId)?.id ?? '';
    this.selectLease();
  }

  protected availableTenantLeases(): LeaseChoice[] {
    return this.paymentLeases().filter((lease) => lease.tenantId === this.selectedTenantId);
  }
  protected selectLease(): void {
    const outstanding = this.paymentCharges()
      .filter((charge) => charge.leaseId === this.selectedLeaseId)
      .reduce((sum, charge) => sum + Number(charge.outstanding), 0);
    this.paymentAmount = outstanding ? outstanding.toFixed(2) : '';
  }

  protected selectedTenantName(): string {
    const tenant = this.paymentTenants().find((item) => item.id === this.selectedTenantId);
    return tenant
      ? `${tenant.firstName} ${tenant.lastName}`
      : this.selectedTenantId || 'No tenant selected';
  }

  protected selectedLeaseUnit(): string {
    return (
      this.paymentLeases().find((item) => item.id === this.selectedLeaseId)?.unit.number ??
      (this.selectedLeaseId || 'No active lease')
    );
  }

  protected selectedOutstanding(): number {
    return this.paymentCharges()
      .filter((charge) => charge.leaseId === this.selectedLeaseId)
      .reduce((sum, charge) => sum + Number(charge.outstanding), 0);
  }

  protected closePayment(): void {
    if (this.paymentLoading()) return;
    this.paymentOpen.set(false);
    this.paymentOpener?.focus();
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      this.searchInput?.nativeElement.focus();
    }
    if (event.key === 'Escape') {
      this.navigationQuery.set('');
      this.menuOpen.set(false);
      this.closePayment();
    }
  }

  protected previousPaymentStep(): void {
    if (this.paymentLoading() || this.paymentRetryPending()) return;
    this.paymentStep.update((step) => Math.max(1, step - 1));
  }

  protected nextPaymentStep(): void {
    if (
      this.paymentStep() === 2 &&
      (!/^\d+(\.\d{1,2})?$/.test(this.paymentAmount) || Number(this.paymentAmount) <= 0)
    ) {
      this.paymentError.set('Enter a positive amount with up to two decimal places.');
      return;
    }
    this.paymentError.set('');
    if (this.paymentStep() < 3) this.paymentStep.update((step) => step + 1);
  }

  protected confirmPayment(): void {
    if (this.paymentLoading() || this.paymentRecoveryBlocked) return;
    const amount = Number(this.paymentAmount);
    if (
      !this.selectedTenantId ||
      !this.selectedLeaseId ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      this.paymentError.set('Choose an active tenant and enter a valid amount.');
      return;
    }
    let remaining = amount;
    const allocations = this.paymentCharges()
      .filter((charge) => charge.leaseId === this.selectedLeaseId)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((charge) => {
        const allocated = Math.min(remaining, Number(charge.outstanding));
        remaining -= allocated;
        return { chargeId: charge.id, amount: allocated.toFixed(2) };
      })
      .filter((allocation) => Number(allocation.amount) > 0);
    this.paymentLoading.set(true);
    this.paymentError.set('');
    this.paymentRequest ??= {
      key: crypto.randomUUID(),
      body: {
        tenantId: this.selectedTenantId,
        leaseId: this.selectedLeaseId,
        amount: amount.toFixed(2),
        method: this.paymentMethod,
        referenceNumber: this.paymentReference || undefined,
        paidAt: new Date().toISOString(),
        allocations,
      },
    };
    let storageKey: string;
    try {
      storageKey = this.paymentStorageKey();
      sessionStorage.setItem(storageKey, JSON.stringify(this.paymentRequest));
    } catch {
      this.paymentLoading.set(false);
      this.paymentError.set('Payment was not sent. Enable browser storage and try again.');
      return;
    }
    this.api
      .post<PostedPayment>('/payments', this.paymentRequest.body, this.paymentRequest.key)
      .subscribe({
        next: (payment) => {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            /* Safe replay remains available. */
          }
          this.paymentRequest = undefined;
          this.paymentRetryPending.set(false);
          this.paymentLoading.set(false);
          this.paymentComplete.set(true);
          this.receiptNumber.set(payment.receiptNumber);
          this.toast.set(`Payment posted. Receipt ${payment.receiptNumber}`);
          window.setTimeout(() => this.toast.set(''), 4500);
        },
        error: (response) => {
          this.paymentLoading.set(false);
          const uncertain =
            !response.status ||
            response.status >= 500 ||
            response.status === 408 ||
            response.status === 409;
          this.paymentRetryPending.set(uncertain);
          // Authentication failures do not prove an earlier attempt failed.
          if (!uncertain && response.status !== 401 && response.status !== 403) {
            try {
              sessionStorage.removeItem(storageKey);
            } catch {
              /* Retain for safe retry. */
            }
            this.paymentRequest = undefined;
          }
          this.paymentError.set(
            uncertain
              ? 'Posting could not be confirmed. Retry this same payment safely. This tab keeps the request if you reload; do not record it in another tab.'
              : (response?.error?.message ?? 'The payment could not be posted.'),
          );
        },
      });
  }

  private paymentStorageKey(): string {
    const profile = this.profile();
    if (!profile) throw new Error('Authentication required');
    return `rentflow.pending-payment:${profile.organization.id}:${profile.user.id}`;
  }

  private restorePayment(): boolean {
    try {
      const saved = sessionStorage.getItem(this.paymentStorageKey());
      this.paymentRecoveryBlocked = false;
      if (!saved) return true;
      const request = JSON.parse(saved);
      if (
        typeof request.key !== 'string' ||
        !request.body?.tenantId ||
        !request.body?.leaseId ||
        !request.body?.amount ||
        !Array.isArray(request.body.allocations)
      ) {
        throw new Error('Invalid saved payment');
      }
      this.paymentRequest = request;
      this.selectedTenantId = request.body.tenantId;
      this.selectedLeaseId = request.body.leaseId;
      this.paymentAmount = request.body.amount;
      this.paymentMethod = request.body.method;
      this.paymentReference = request.body.referenceNumber ?? '';
      this.paymentStep.set(3);
      this.paymentComplete.set(false);
      this.paymentRetryPending.set(true);
      this.paymentError.set(
        'An earlier payment is awaiting confirmation. Retry to retrieve its receipt or finish recording it.',
      );
      return true;
    } catch {
      this.paymentRecoveryBlocked = true;
      this.paymentError.set(
        'Cannot recover payment state. Check payment history before recording another payment.',
      );
      this.paymentOpen.set(true);
      this.paymentLoading.set(false);
      return false;
    }
  }

  protected signOut(): void {
    this.api.logout().subscribe({ next: () => void this.router.navigate(['/auth']) });
  }
}
