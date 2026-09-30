import { Injectable, signal } from '@angular/core';

/** Lets any screen open the Record-payment sheet preselected for a lease. */
@Injectable({ providedIn: 'root' })
export class PaymentLauncher {
  readonly request = signal<{ leaseId?: string; at: number } | null>(null);

  open(leaseId?: string): void {
    this.request.set({ leaseId, at: Date.now() });
  }
}
