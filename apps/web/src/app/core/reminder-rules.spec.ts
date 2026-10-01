import { describe, expect, it } from 'vitest';
import type { ReminderRules } from './models';
import { describeTenantSchedule, parseDays } from './reminder-rules';

const rules: ReminderRules = {
  tenantReminders: true,
  daysBeforeDue: 3,
  onDueDate: true,
  overdueDays: [3, 7],
  staffLeaseAlerts: true,
  leaseExpiryDays: [60, 30, 7],
};

describe('parseDays', () => {
  it('reads comma or space separated days, sorted and de-duplicated', () => {
    expect(parseDays('7, 3', 1, 60)).toEqual([3, 7]);
    expect(parseDays('30 60 7 30', 1, 120)).toEqual([7, 30, 60]);
    expect(parseDays('', 1, 60)).toEqual([]);
  });

  it('rejects out-of-range, non-numeric, and too many entries', () => {
    expect(parseDays('0', 1, 60)).toBeNull();
    expect(parseDays('61', 1, 60)).toBeNull();
    expect(parseDays('3, two', 1, 60)).toBeNull();
    expect(parseDays('1, 2, 3, 4', 1, 60)).toBeNull();
  });
});

describe('describeTenantSchedule', () => {
  it('summarises the schedule in one sentence', () => {
    expect(describeTenantSchedule(rules)).toBe(
      'Tenants with an unpaid balance get an email 3 days before rent is due, on the due date, and 3 and 7 days after it becomes overdue.',
    );
    expect(describeTenantSchedule({ ...rules, daysBeforeDue: 1, onDueDate: false, overdueDays: [1] })).toBe(
      'Tenants with an unpaid balance get an email 1 day before rent is due and 1 day after it becomes overdue.',
    );
    expect(describeTenantSchedule({ ...rules, daysBeforeDue: 0, onDueDate: false, overdueDays: [] })).toBe('No rent emails are scheduled.');
  });
});
