import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/** Surfaces new app versions so users never run a stale bundle against a newer API. */
@Injectable({ providedIn: 'root' })
export class AppUpdate {
  private readonly updates = inject(SwUpdate, { optional: true });
  readonly available = signal(false);

  constructor() {
    const updates = this.updates;
    if (!updates?.isEnabled) return;
    updates.versionUpdates.subscribe((event) => {
      if (event.type === 'VERSION_READY') this.available.set(true);
    });
    updates.unrecoverable.subscribe(() => document.location.reload());
    // Check periodically for long-lived installed sessions.
    setInterval(() => void updates.checkForUpdate().catch(() => undefined), 30 * 60 * 1000);
  }

  async apply(): Promise<void> {
    await this.updates?.activateUpdate().catch(() => undefined);
    document.location.reload();
  }
}
