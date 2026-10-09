import { Injectable, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'rentflow.theme';

/** Per-device appearance preference. "system" follows the operating system setting. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(this.read());

  constructor() {
    this.apply(this.preference());
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    // Cross-fade the whole screen between themes where supported and motion is welcome.
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;
    if (reduce || !document.startViewTransition) this.apply(preference);
    else {
      const root = document.documentElement;
      root.classList.add('theme-switching');
      document
        .startViewTransition(() => this.apply(preference))
        .finished.finally(() => root.classList.remove('theme-switching'));
    }
    try {
      if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  private apply(preference: ThemePreference): void {
    const root = document.documentElement;
    if (preference === 'system') delete root.dataset['theme'];
    else root.dataset['theme'] = preference;
  }

  private read(): ThemePreference {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  }
}
