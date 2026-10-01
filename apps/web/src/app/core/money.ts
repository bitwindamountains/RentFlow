/**
 * Money is exchanged with the API as decimal strings and handled here as
 * integer centavos, so no binary floating-point rounding can occur.
 */
export const MONEY_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

export function toCents(value: string | null | undefined): number {
  const text = String(value ?? '0').trim();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace(/^-/, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  if (!Number.isFinite(cents)) return 0;
  return negative ? -cents : cents;
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function isMoney(value: string): boolean {
  return MONEY_PATTERN.test(value.trim()) && toCents(value) > 0;
}

/** Oldest-first allocation of a payment across open charges. */
export function allocateOldestFirst(
  amount: string,
  charges: Array<{ id: string; dueDate: string; outstanding: string }>,
): Array<{ chargeId: string; amount: string }> {
  let remaining = toCents(amount);
  return [...charges]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((charge) => {
      const applied = Math.min(remaining, toCents(charge.outstanding));
      remaining -= applied;
      return { chargeId: charge.id, amount: fromCents(applied) };
    })
    .filter((item) => toCents(item.amount) > 0);
}

export function sumCents(values: Array<string | null | undefined>): number {
  return values.reduce((total, value) => total + toCents(value), 0);
}
