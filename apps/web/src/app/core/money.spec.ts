import { allocateOldestFirst, fromCents, isMoney, sumCents, toCents } from './money';

describe('money (centavos)', () => {
  it('round-trips decimal strings exactly', () => {
    for (const value of ['0.00', '0.10', '1.05', '1234567.89', '-850.00'])
      expect(fromCents(toCents(value))).toBe(value);
    expect(toCents('12.5')).toBe(1250);
  });

  it('sums without floating-point drift', () => {
    expect(fromCents(sumCents(['0.10', '0.20', '0.30']))).toBe('0.60');
  });

  it('validates money input', () => {
    expect(isMoney('100.5')).toBe(true);
    expect(isMoney('0')).toBe(false);
    expect(isMoney('1.234')).toBe(false);
    expect(isMoney('abc')).toBe(false);
  });

  it('allocates oldest first and never exceeds the payment', () => {
    const charges = [
      { id: 'b', dueDate: '2026-02-05', outstanding: '33.34' },
      { id: 'a', dueDate: '2026-01-05', outstanding: '33.33' },
      { id: 'c', dueDate: '2026-03-05', outstanding: '33.33' },
    ];
    const allocations = allocateOldestFirst('50.00', charges);
    expect(allocations).toEqual([
      { chargeId: 'a', amount: '33.33' },
      { chargeId: 'b', amount: '16.67' },
    ]);
    expect(sumCents(allocations.map((a) => a.amount))).toBe(5000);
    expect(sumCents(allocateOldestFirst('100.30', charges).map((a) => a.amount))).toBe(10000);
  });
});
