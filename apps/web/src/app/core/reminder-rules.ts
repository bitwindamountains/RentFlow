import type { ReminderRules } from './models';

/**
 * Reads a list like "3, 7" into distinct whole days within [min, max], sorted.
 * Returns null when the text is not a valid list or has more than `limit` entries.
 */
export function parseDays(text: string, min: number, max: number, limit = 3): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  const days = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  if (days.length > limit || days.some((day) => day < min || day > max)) return null;
  return days;
}

function list(items: string[], serialComma = false): string {
  if (items.length <= 1) return items.join('');
  const last = items.length > 2 && serialComma ? ', and ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${last}${items.at(-1)}`;
}

const plural = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** One plain sentence describing when tenants are emailed. */
export function describeTenantSchedule(rules: ReminderRules): string {
  const parts: string[] = [];
  if (rules.daysBeforeDue > 0) parts.push(`${plural(rules.daysBeforeDue)} before rent is due`);
  if (rules.onDueDate) parts.push('on the due date');
  if (rules.overdueDays.length)
    parts.push(`${list(rules.overdueDays.map(String))} ${rules.overdueDays.at(-1) === 1 ? 'day' : 'days'} after it becomes overdue`);
  return parts.length ? `Tenants with an unpaid balance get an email ${list(parts, true)}.` : 'No rent emails are scheduled.';
}
