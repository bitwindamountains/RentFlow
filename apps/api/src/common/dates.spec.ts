import { describe, expect, it } from 'vitest';
import { addDays, firstOfNextMonth, isDateOnly, todayInZone, paymentDateInstant } from './dates.js';

describe('dates', () => {
  it.each([
    ['2027-01-01', 'Asia/Manila', '2026-12-31T16:00:01Z', '2026-12-31T16:00:00.000Z'],
    ['2026-10-09', 'Asia/Manila', '2026-10-09T00:30:00Z', '2026-10-08T16:00:00.000Z'],
    ['2026-03-08', 'America/New_York', '2026-03-09T00:00:00Z', '2026-03-08T05:00:00.000Z'],
    ['2026-11-01', 'America/New_York', '2026-11-02T00:00:00Z', '2026-11-01T04:00:00.000Z'],
  ])('converts reported day %s in %s without a future timestamp', (day, zone, now, expected) => {
    expect(paymentDateInstant(day, zone, new Date(now))).toBe(expected);
    expect(paymentDateInstant(day, zone, new Date(now))).toBe(paymentDateInstant(day, zone, new Date(Date.parse(now) + 60_000)));
  });

  it('rejects future and nonexistent payment dates', () => {
    expect(() => paymentDateInstant('2027-01-02', 'Asia/Manila', new Date('2026-12-31T16:01:00Z'))).toThrow();
    expect(() => paymentDateInstant('2026-02-30', 'Asia/Manila')).toThrow();
  });
  it('validates real calendar dates only', () => {
    expect(isDateOnly('2028-02-29')).toBe(true);
    expect(isDateOnly('2027-02-29')).toBe(false);
    expect(isDateOnly('2026-13-01')).toBe(false);
    expect(isDateOnly('2026-1-1')).toBe(false);
  });

  it('computes today in the organization time zone, not UTC', () => {
    // 2026-10-01 20:30 UTC is already 2026-10-02 in Manila (UTC+8).
    const instant = new Date('2026-10-01T20:30:00Z');
    expect(todayInZone('Asia/Manila', instant)).toBe('2026-10-02');
    expect(todayInZone('UTC', instant)).toBe('2026-10-01');
  });

  it('does date arithmetic across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(firstOfNextMonth('2026-12-15')).toBe('2027-01-01');
  });
});
