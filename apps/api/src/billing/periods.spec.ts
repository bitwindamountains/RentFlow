import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { dueDateFor, duePeriods, prorateFromDate, prorateRange } from './periods.js';

const rent = (value: string) => new Prisma.Decimal(value);

describe('duePeriods', () => {
  const monthly = { startsOn: '2026-02-01', billingDay: 1, dueDay: 5 };

  it('lists one period per month up to and including the as-of date', () => {
    expect(duePeriods(monthly, '2026-04-01').map((p) => p.period)).toEqual(['2026-02', '2026-03', '2026-04']);
  });

  it('excludes a month whose billing day has not arrived yet', () => {
    const periods = duePeriods({ ...monthly, billingDay: 15, dueDay: 20 }, '2026-04-14');
    expect(periods.map((p) => p.period)).toEqual(['2026-02', '2026-03']);
  });

  it('never bills before the schedule starts (mid-month start)', () => {
    const periods = duePeriods({ startsOn: '2026-02-10', billingDay: 5, dueDay: 10 }, '2026-03-31');
    expect(periods.map((p) => p.billingDate)).toEqual(['2026-03-05']);
  });

  it('stops at the schedule end date', () => {
    const periods = duePeriods({ ...monthly, endsOn: '2026-03-15' }, '2026-12-31');
    expect(periods.map((p) => p.period)).toEqual(['2026-02', '2026-03']);
  });

  it('places the due date in the next month when the due day precedes the billing day', () => {
    const [first] = duePeriods({ startsOn: '2026-01-01', billingDay: 25, dueDay: 5 }, '2026-01-31');
    expect(first).toEqual({ period: '2026-01', billingDate: '2026-01-25', dueDate: '2026-02-05' });
  });

  it('rolls December bills with an early due day into January of the next year', () => {
    expect(dueDateFor(2026, 11, 20, 3)).toBe('2027-01-03');
  });

  it('handles February in leap and non-leap years with day 28', () => {
    expect(duePeriods({ startsOn: '2028-02-01', billingDay: 28, dueDay: 28 }, '2028-02-29')[0]!.dueDate).toBe(
      '2028-02-28',
    );
    expect(duePeriods({ startsOn: '2027-02-01', billingDay: 28, dueDay: 28 }, '2027-02-28')).toHaveLength(1);
  });

  it('crosses year boundaries without skipping or repeating months', () => {
    const periods = duePeriods({ startsOn: '2025-11-01', billingDay: 1, dueDay: 1 }, '2026-02-01');
    expect(periods.map((p) => p.period)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('returns nothing when the as-of date precedes the start', () => {
    expect(duePeriods(monthly, '2026-01-31')).toEqual([]);
  });
});

describe('proration', () => {
  it('charges the full month when moving in on the 1st', () => {
    expect(prorateFromDate(rent('10000'), '2026-04-01').toFixed(2)).toBe('10000.00');
  });

  it('uses actual days in a 30-day month', () => {
    // 15 of 30 days remain from April 16.
    expect(prorateFromDate(rent('10000'), '2026-04-16').toFixed(2)).toBe('5000.00');
  });

  it('uses actual days in February (28 days) and a leap February (29 days)', () => {
    expect(prorateFromDate(rent('2800'), '2027-02-15').toFixed(2)).toBe('1400.00');
    expect(prorateFromDate(rent('2900'), '2028-02-15').toFixed(2)).toBe('1500.00');
  });

  it('rounds half-up to centavos', () => {
    // 1 of 31 days of 1000.00 = 32.2580… → 32.26
    expect(prorateFromDate(rent('1000'), '2026-01-31').toFixed(2)).toBe('32.26');
  });

  it('prorates a range inside one month inclusively', () => {
    expect(prorateRange(rent('3000'), '2026-06-01', '2026-06-10').toFixed(2)).toBe('1000.00');
  });
});
