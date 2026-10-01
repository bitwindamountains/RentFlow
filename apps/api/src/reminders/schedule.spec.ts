import { describe, expect, it } from 'vitest';
import { hourInZone } from '../common/dates.js';
import { DEFAULT_RULES, dueStep, expiryStep, overdueStep, type ReminderRules } from './schedule.js';

const rules: ReminderRules = { ...DEFAULT_RULES, tenantReminders: true };

describe('dueStep', () => {
  it('sends "due soon" from the configured day and "due today" on the due date', () => {
    expect(dueStep(rules, '2026-10-05', '2026-10-01')).toBeNull();
    expect(dueStep(rules, '2026-10-05', '2026-10-02')).toEqual({ kind: 'RENT_DUE_SOON', step: -3 });
    expect(dueStep(rules, '2026-10-05', '2026-10-04')).toEqual({ kind: 'RENT_DUE_SOON', step: -3 });
    expect(dueStep(rules, '2026-10-05', '2026-10-05')).toEqual({ kind: 'RENT_DUE_TODAY', step: 0 });
    expect(dueStep(rules, '2026-10-05', '2026-10-06')).toBeNull();
  });

  it('honours turned-off steps and never sends a stale "due soon" on the due date', () => {
    const soonOnly = { ...rules, onDueDate: false, daysBeforeDue: 3 };
    expect(dueStep(soonOnly, '2026-10-05', '2026-10-05')).toBeNull();
    expect(dueStep({ ...rules, daysBeforeDue: 0 }, '2026-10-05', '2026-10-03')).toBeNull();
  });
});

describe('overdueStep', () => {
  it('counts from the end of the grace period and sends the latest arrived step', () => {
    expect(overdueStep(rules, '2026-10-05', 0, '2026-10-07')).toBeNull();
    expect(overdueStep(rules, '2026-10-05', 0, '2026-10-08')).toBe(3);
    expect(overdueStep(rules, '2026-10-05', 0, '2026-10-12')).toBe(7);
    expect(overdueStep(rules, '2026-10-05', 5, '2026-10-12')).toBeNull();
    expect(overdueStep(rules, '2026-10-05', 5, '2026-10-13')).toBe(3);
  });

  it('skips balances that are long past every step', () => {
    expect(overdueStep(rules, '2026-06-05', 0, '2026-10-01')).toBeNull();
  });
});

describe('expiryStep', () => {
  it('alerts at each configured distance before the end date, with a short catch-up', () => {
    expect(expiryStep(rules, '2026-12-31', '2026-10-31')).toBeNull();
    expect(expiryStep(rules, '2026-12-31', '2026-11-01')).toBe(60);
    expect(expiryStep(rules, '2026-12-31', '2026-11-03')).toBe(60);
    expect(expiryStep(rules, '2026-12-31', '2026-11-04')).toBeNull();
    expect(expiryStep(rules, '2026-12-31', '2026-12-24')).toBe(7);
    expect(expiryStep(rules, '2026-12-31', '2027-01-01')).toBeNull();
  });
});

describe('hourInZone', () => {
  it('reads the wall-clock hour in the workspace time zone', () => {
    expect(hourInZone('Asia/Manila', new Date('2026-10-01T00:30:00Z'))).toBe(8);
    expect(hourInZone('Asia/Manila', new Date('2026-10-01T16:00:00Z'))).toBe(0);
  });
});
