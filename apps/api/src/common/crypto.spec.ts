import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertPasswordPolicy, hashPassword, needsRehash, stableStringify, verifyPassword } from './crypto.js';

/** The format written before versioned hashes: `<salt>:<hash>` with Node's default scrypt cost. */
function legacyHash(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

describe('passwords', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^s2\$14\$8\$5\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery staple', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('still verifies hashes from before versioning and flags them for rehashing', async () => {
    const old = legacyHash('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', old)).toBe(true);
    expect(await verifyPassword('wrong horse battery staple', old)).toBe(false);
    expect(needsRehash(old)).toBe(true);
  });

  it('fails closed on malformed or out-of-range stored hashes', async () => {
    const good = await hashPassword('correct horse battery staple');
    const [, , r, p, salt, hash] = good.split('$');
    for (const bad of ['', 'nonsense', 'a:b:c', `s2$30$${r}$${p}$${salt}$${hash}`, `s2$14$x$${p}$${salt}$${hash}`, `s3$14$${r}$${p}$${salt}$${hash}`, `s2$14$${r}$${p}$${salt}$`]) {
      expect(await verifyPassword('correct horse battery staple', bad), bad).toBe(false);
      expect(needsRehash(bad), bad).toBe(true);
    }
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
