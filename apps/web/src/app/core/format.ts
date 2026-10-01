import { Pipe, type PipeTransform, inject } from '@angular/core';
import { ApiClient } from './api-client.service';
export { todayIn } from './dates';

const LOCALE = 'en-PH';

/** Formats a decimal string in the organization's currency (e.g. ₱12,500.00). */
@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  private readonly api = inject(ApiClient);
  transform(value: string | number | null | undefined): string {
    if (value === null || value === undefined || value === '') return '—';
    const currency = this.api.profile()?.organization.currency ?? 'PHP';
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(Number(value));
  }
}

/** `YYYY-MM-DD` calendar dates, shown without any time-zone shift. */
@Pipe({ name: 'day' })
export class DayPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
  }
}

/** Timestamps shown in the organization's time zone. */
@Pipe({ name: 'moment' })
export class MomentPipe implements PipeTransform {
  private readonly api = inject(ApiClient);
  transform(value: string | null | undefined, style: 'date' | 'datetime' = 'datetime'): string {
    if (!value) return '—';
    const timeZone = this.api.profile()?.organization.timezone ?? 'Asia/Manila';
    return new Intl.DateTimeFormat(LOCALE, {
      dateStyle: 'medium',
      ...(style === 'datetime' ? { timeStyle: 'short' } : {}),
      timeZone,
    }).format(new Date(value));
  }
}

const labels: Record<string, string> = {
  BANK_TRANSFER: 'Bank transfer',
  GCASH: 'GCash',
  MAYA: 'Maya',
  IN_PROGRESS: 'In progress',
  CREDIT_NOTE: 'Credit note',
  ASSOCIATION_FEE: 'Association fee',
  CHARGE_ADJUSTMENT: 'Adjustment',
  PAYMENT_REVERSAL: 'Payment reversal',
};

/** Turns API enums (POSTED, BANK_TRANSFER) into readable labels. */
@Pipe({ name: 'label' })
export class LabelPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '—';
    return labels[value] ?? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase().replaceAll('_', ' ');
  }
}

/** Maps a status to the existing badge colours. */
export function statusTone(status: string | null | undefined): string {
  switch (status) {
    case 'POSTED':
    case 'ACTIVE':
    case 'COMPLETED':
    case 'AVAILABLE':
      return 'status success';
    case 'REVERSED':
    case 'VOIDED':
    case 'TERMINATED':
    case 'CANCELLED':
    case 'SUSPENDED':
    case 'URGENT':
      return 'status danger';
    default:
      return 'status warning';
  }
}


export const FORMAT_PIPES = [MoneyPipe, DayPipe, MomentPipe, LabelPipe] as const;
