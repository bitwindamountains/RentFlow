import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiClient } from '../core/api-client.service';

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
  protected property = { name: '', type: 'Apartment', address: '', city: '' };
  protected unit = { number: '', type: 'Studio', monthlyRent: '' };
  protected tenant = { firstName: '', lastName: '', email: '', phone: '' };
  protected lease = {
    startDate: new Date().toISOString().slice(0, 10),
    monthlyRent: '',
    billingDay: 1,
    dueDay: 5,
  };
  protected charge = {
    description: 'First month rent',
    dueDate: new Date().toISOString().slice(0, 10),
    billingPeriod: new Date().toISOString().slice(0, 7),
  };

  protected next(formValid: boolean | null): void {
    if (formValid !== true) return;
    if (this.step() === 1 && !this.lease.monthlyRent)
      this.lease.monthlyRent = this.unit.monthlyRent;
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
      tenant: { ...this.tenant, email: this.tenant.email.trim() || undefined },
      lease: this.lease,
      charge: this.charge,
    });
    this.api.post('/rental-setup', this.requestBody, this.requestKey).subscribe({
      next: () => {
        this.saving.set(false);
        void this.router.navigate(['/dashboard'], { queryParams: { setup: 'complete' } });
      },
      error: (response) => {
        this.saving.set(false);
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 409
        ) {
          this.requestBody = undefined;
          this.requestKey = crypto.randomUUID();
        }
        this.error.set(
          response?.error?.message ??
            'Could not confirm setup. Retry to check the same request safely. No partial rental is saved.',
        );
      },
    });
  }
}
