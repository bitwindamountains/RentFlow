import { DomainError } from './errors.js';

/** Calendar dates are exchanged as `YYYY-MM-DD` and stored as UTC midnight. */
export const DATE_ONLY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return false;
  return formatDateOnly(new Date(`${value}T00:00:00.000Z`)) === value;
}

export function parseDateOnly(value: string): Date {
  if (!isDateOnly(value)) throw new DomainError('INVALID_DATE');
  return new Date(`${value}T00:00:00.000Z`);
}

export function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Today's calendar date in an IANA time zone, e.g. `Asia/Manila`. */
export function todayInZone(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The hour (0–23) on the wall clock in an IANA time zone. */
export function hourInZone(timeZone: string, now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now),
  );
}

export function addDays(date: string, days: number): string {
  const value = parseDateOnly(date);
  value.setUTCDate(value.getUTCDate() + days);
  return formatDateOnly(value);
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / 86_400_000,
  );
}

export function periodOf(date: string): string {
  return date.slice(0, 7);
}

/** `YYYY-MM-DD` for a year, zero-based month (may overflow), and day. */
export function dateOf(year: number, monthIndex: number, day: number): string {
  return formatDateOnly(new Date(Date.UTC(year, monthIndex, day)));
}

export function firstOfNextMonth(date: string): string {
  const value = parseDateOnly(date);
  return dateOf(value.getUTCFullYear(), value.getUTCMonth() + 1, 1);
}
