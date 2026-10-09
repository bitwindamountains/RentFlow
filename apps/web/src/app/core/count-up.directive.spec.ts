import { formatFigure, parseFigure } from './count-up.directive';

describe('count-up figures', () => {
  it('keeps currency, grouping and decimals around the animated number', () => {
    const peso = parseFigure('₱13,000.00')!;
    expect(peso).toEqual({ before: '₱', after: '', value: 13000, decimals: 2, grouped: true });
    expect(formatFigure(peso, 6543.219)).toBe('₱6,543.22');
    expect(formatFigure(peso, 0)).toBe('₱0.00');
  });

  it('handles percentages, negatives and text without a number', () => {
    expect(formatFigure(parseFigure('66.7%')!, 12.34)).toBe('12.3%');
    // A sign before the symbol stays in the prefix, so in-between values keep it.
    expect(formatFigure(parseFigure('-₱850.00')!, 425)).toBe('-₱425.00');
    expect(parseFigure('₱-850.00')!.value).toBe(-850);
    expect(parseFigure('—')).toBeNull();
  });
});
