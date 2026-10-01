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
    this.apply(preference);
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
