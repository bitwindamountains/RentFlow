import { describe, expect, it } from 'vitest';
import { assertPasswordPolicy, hashPassword, stableStringify, verifyPassword } from './crypto.js';

describe('passwords', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery staple', hash)).toBe(false);
  });

  it('returns false (after doing the same work) when there is no account', async () => {
    expect(await verifyPassword('anything at all', undefined)).toBe(false);
  });

  it('rejects short passwords and passwords containing the email name', () => {
    expect(() => assertPasswordPolicy('short', 'maria@example.com')).toThrow(/at least 12 characters/);
    expect(() => assertPasswordPolicy('maria-secret-2026', 'maria@example.com')).toThrow(/at least 12 characters/);
    expect(() => assertPasswordPolicy('a long unrelated passphrase', 'maria@example.com')).not.toThrow();
  });

  it('fingerprints requests independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
