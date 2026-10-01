import { addDays, daysBetween } from '../common/dates.js';

/** Days after a step's date that a missed step (server down, rule just enabled) is still sent. */
export const CATCH_UP_DAYS = 2;

export interface ReminderRules {
  tenantReminders: boolean;
  daysBeforeDue: number;
  onDueDate: boolean;
  overdueDays: number[];
  staffLeaseAlerts: boolean;
  leaseExpiryDays: number[];
}

export const DEFAULT_RULES: ReminderRules = {
  tenantReminders: false,
  daysBeforeDue: 3,
  onDueDate: true,
  overdueDays: [3, 7],
  staffLeaseAlerts: true,
  leaseExpiryDays: [60, 30, 7],
};

export type DueStep = { kind: 'RENT_DUE_SOON' | 'RENT_DUE_TODAY'; step: number };

/**
 * The reminder to send today for an amount due on `dueDate`, if any. Only the
 * latest step that has arrived is sent, and only within the catch-up window,
 * so a tenant never receives a burst of stale reminders.
 */
export function dueStep(rules: ReminderRules, dueDate: string, today: string): DueStep | null {
  const daysPast = daysBetween(dueDate, today);
  if (daysPast > 0) return null;
  const steps: DueStep[] = [];
  if (rules.daysBeforeDue > 0) steps.push({ kind: 'RENT_DUE_SOON', step: -rules.daysBeforeDue });
  if (rules.onDueDate) steps.push({ kind: 'RENT_DUE_TODAY', step: 0 });
  const arrived = steps.filter((s) => s.step <= daysPast).at(-1);
  return arrived && daysPast - arrived.step <= CATCH_UP_DAYS ? arrived : null;
}

/**
 * The overdue step to send today for a lease whose oldest unpaid charge was
 * due on `oldestDueDate`. Overdue days count from the end of the grace period,
 * matching how arrears are reported.
 */
export function overdueStep(rules: ReminderRules, oldestDueDate: string, graceDays: number, today: string): number | null {
  const late = daysBetween(addDays(oldestDueDate, graceDays), today);
  if (late <= 0) return null;
  const arrived = [...rules.overdueDays].sort((a, b) => a - b).filter((n) => n <= late).at(-1);
  return arrived !== undefined && late - arrived <= CATCH_UP_DAYS ? arrived : null;
}

/** Days before `endDate` for the lease-expiry alert to send today, if any. */
export function expiryStep(rules: ReminderRules, endDate: string, today: string): number | null {
  const remaining = daysBetween(today, endDate);
  if (remaining < 0) return null;
  const arrived = [...rules.leaseExpiryDays].sort((a, b) => a - b).find((n) => n >= remaining);
  return arrived !== undefined && arrived - remaining <= CATCH_UP_DAYS ? arrived : null;
}
