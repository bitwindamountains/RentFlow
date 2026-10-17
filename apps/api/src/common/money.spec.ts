import { describe, expect, it } from 'vitest';
import { displayMoney, formatMoney, parseMoney, sumMoney } from './money.js';

describe('money', () => {
  it('accepts up to two decimals and rejects everything else', () => {
    expect(parseMoney('1250.5').toFixed(2)).toBe('1250.50');
    for (const bad of ['1.234', '-5', '1e3', ' 5', '0', '0.00', '', 'NaN', '12345678901234'])
      expect(() => parseMoney(bad), bad).toThrow();
  });

  it('allows zero only when requested', () => {
    expect(parseMoney('0', { allowZero: true }).toFixed(2)).toBe('0.00');
  });

  it('adds exactly without binary floating-point error', () => {
    expect(formatMoney(sumMoney(['0.10', '0.20', '0.30']))).toBe('0.60');
    expect(formatMoney(sumMoney(Array.from({ length: 1000 }, () => '0.01')))).toBe('10.00');
  });

  it('displays amounts with the currency sign and separators, without losing centavos', () => {
    expect(displayMoney('18000', 'PHP')).toBe('₱18,000.00');
    expect(displayMoney('9007199254740993.01', 'PHP')).toBe('₱9,007,199,254,740,993.01');
  });
});
