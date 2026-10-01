import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiClient, isUncertain, type ApiError } from '../core/api-client.service';

@Component({
  selector: 'app-setup-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './setup.page.html',
})
export class SetupPage {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  protected readonly step = signal(1);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  private requestKey = crypto.randomUUID();
  private requestBody?: object;
  private readonly today = this.api.today();
  protected property = { name: '', type: 'Apartment', address: '', city: '' };
  protected unit = { number: '', type: 'Studio', monthlyRent: '' };
  protected tenant = { firstName: '', lastName: '', email: '', phone: '' };
  protected lease = { startDate: this.today, monthlyRent: '', billingDay: 1, dueDay: 5, depositRequired: '' };
  protected charge = { description: 'Move-in month rent', dueDate: this.today, billingPeriod: this.today.slice(0, 7) };

  protected next(formValid: boolean | null): void {
    if (formValid !== true) return;
    if (this.step() === 1 && !this.lease.monthlyRent) this.lease.monthlyRent = this.unit.monthlyRent;
    if (this.step() === 3) this.charge.billingPeriod = this.lease.startDate.slice(0, 7);
    this.step.update((value) => Math.min(4, value + 1));
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  protected back(): void {
    if (this.requestBody) {
      this.error.set('Retry the reviewed setup to confirm its result before changing details.');
      return;
    }
    this.step.update((value) => Math.max(1, value - 1));
  }

  protected finish(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.requestBody ??= structuredClone({
      property: this.property,
      unit: this.unit,
      tenant: { ...this.tenant, email: this.tenant.email.trim() || undefined, phone: this.tenant.phone.trim() || undefined },
      lease: { ...this.lease, depositRequired: this.lease.depositRequired || undefined, firstMonth: 'FULL' },
      charge: { ...this.charge, billingPeriod: this.lease.startDate.slice(0, 7) },
    });
    this.api.post<{ tenantId: string }>('/rental-setup', this.requestBody, this.requestKey).subscribe({
      next: (result) => {
        this.saving.set(false);
        void this.router.navigate(['/tenants', result.tenantId]);
      },
      error: (error: ApiError) => {
        this.saving.set(false);
        if (!isUncertain(error)) {
          // A definite rejection: the details can be corrected and resent with a new key.
          this.requestBody = undefined;
          this.requestKey = crypto.randomUUID();
          this.error.set(error.message);
        } else {
          this.error.set('Could not confirm setup. Retry to check the same request safely — no duplicate rental will be created.');
        }
      },
    });
  }
}
