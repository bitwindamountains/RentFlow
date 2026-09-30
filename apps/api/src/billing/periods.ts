import { Prisma } from '@prisma/client';
import { dateOf, daysBetween, daysInMonth, parseDateOnly } from '../common/dates.js';
import { roundMoney } from '../common/money.js';

export interface ScheduleWindow {
  /** First date (inclusive) on which a bill may be issued. */
  startsOn: string;
  /** Last date (inclusive) on which a bill may be issued. */
  endsOn?: string | null;
  billingDay: number;
  dueDay: number;
}

export interface DuePeriod {
  /** `YYYY-MM` of the billing date. */
  period: string;
  billingDate: string;
  dueDate: string;
}

/**
 * Due date for a bill issued in (year, monthIndex). Days are limited to 1–28,
 * so every month has them; a due day before the billing day falls in the
 * following month, never before the bill exists.
 */
export function dueDateFor(year: number, monthIndex: number, billingDay: number, dueDay: number): string {
  return dateOf(year, monthIndex + (dueDay < billingDay ? 1 : 0), dueDay);
}

/**
 * Every billing period of a schedule whose billing date is on or before
 * `asOf` and inside the schedule window. Pure and deterministic, so the
 * billing run can compare it with already-posted periods.
 */
export function duePeriods(schedule: ScheduleWindow, asOf: string): DuePeriod[] {
  const start = parseDateOnly(schedule.startsOn);
  const limit = parseDateOnly(asOf);
  const periods: DuePeriod[] = [];
  for (
    let year = start.getUTCFullYear(), month = start.getUTCMonth();
    Date.UTC(year, month, 1) <= limit.getTime();
    month === 11 ? ((month = 0), year++) : month++
  ) {
    const billingDate = dateOf(year, month, schedule.billingDay);
    if (billingDate < schedule.startsOn || billingDate > asOf) continue;
    if (schedule.endsOn && billingDate > schedule.endsOn) continue;
    periods.push({
      period: billingDate.slice(0, 7),
      billingDate,
      dueDate: dueDateFor(year, month, schedule.billingDay, schedule.dueDay),
    });
  }
  return periods;
}

/**
 * Rent for the remainder of a month starting on `from` (inclusive), using the
 * actual number of days in that month and half-up rounding to centavos.
 */
export function prorateFromDate(monthlyRent: Prisma.Decimal, from: string): Prisma.Decimal {
  const date = parseDateOnly(from);
  const total = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
  const remaining = total - date.getUTCDate() + 1;
  return roundMoney(monthlyRent.mul(remaining).div(total));
}

/** Rent for `from`..`to` inclusive within a single month. */
export function prorateRange(monthlyRent: Prisma.Decimal, from: string, to: string): Prisma.Decimal {
  const date = parseDateOnly(from);
  const total = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
  return roundMoney(monthlyRent.mul(daysBetween(from, to) + 1).div(total));
}
