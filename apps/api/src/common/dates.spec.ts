import { describe, expect, it } from 'vitest';
import { addDays, firstOfNextMonth, isDateOnly, todayInZone } from './dates.js';

describe('dates', () => {
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
