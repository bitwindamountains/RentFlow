import { Prisma } from '@prisma/client';
import { DomainError } from './errors.js';

export type Money = Prisma.Decimal;
export const ZERO = new Prisma.Decimal(0);

/** Up to 13 integer digits and two decimals; matches numeric(19,4) safely. */
export const MONEY_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

export function parseMoney(value: string, options: { allowZero?: boolean } = {}): Money {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value))
    throw new DomainError('INVALID_MONEY');
  const amount = new Prisma.Decimal(value);
  if (options.allowZero ? amount.isNegative() : !amount.greaterThan(0))
    throw new DomainError('INVALID_MONEY');
  return amount;
}

export function formatMoney(value: Prisma.Decimal.Value | null | undefined): string {
  return new Prisma.Decimal(value ?? 0).toFixed(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Money as people read it in text the server writes (₱18,000.00); never parse it back. */
export function displayMoney(value: Prisma.Decimal.Value, currency: string): string {
  // The decimal string keeps full precision; Intl accepts it without going through a JS number.
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(formatMoney(value) as Intl.StringNumericLiteral);
}

export function sumMoney(values: Iterable<Prisma.Decimal.Value>): Money {
  let total = ZERO;
  for (const value of values) total = total.plus(value);
  return total;
}

/** Rounds to centavos using half-up, the convention for PHP invoices. */
export function roundMoney(value: Money): Money {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
