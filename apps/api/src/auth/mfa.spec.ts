import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetEnvironmentCache } from '../config/environment.js';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryCodeHash,
  timeStep,
  totpCode,
  verifyTotp,
} from './mfa.js';

// RFC 6238 appendix B (SHA-1 seed "12345678901234567890"), last six digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpCode(RFC_SECRET, timeStep(59_000))).toBe('287082');
    expect(totpCode(RFC_SECRET, timeStep(1_111_111_109_000))).toBe('081804');
    expect(totpCode(RFC_SECRET, timeStep(1_234_567_890_000))).toBe('005924');
    expect(totpCode(RFC_SECRET, timeStep(2_000_000_000_000))).toBe('279037');
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts one step of clock drift and refuses replays', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), null, now)).toBeNull();
    // The same code, or an older one, after it was used.
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), step, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), step, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, `${totpCode(RFC_SECRET, step).slice(0, 3)} ${totpCode(RFC_SECRET, step).slice(3)}`, null, now)).toBe(step);
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    expect(otpauthUri('ABC', 'maria@example.ph')).toBe(
      'otpauth://totp/RentFlow%3Amaria%40example.ph?secret=ABC&issuer=RentFlow&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('secret encryption', () => {
  beforeAll(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', 'postgresql://unit:unit@localhost:5432/unit');
    vi.stubEnv('MFA_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    resetEnvironmentCache();
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    resetEnvironmentCache();
  });

  it('encrypts with a fresh IV and detects tampering', () => {
    const secret = newTotpSecret();
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(decryptSecret(a)).toBe(secret);
    const parts = a.split(':');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 1;
    parts[3] = body.toString('base64url');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});

describe('recovery codes', () => {
  it('are distinct, readable, and hashed independent of case and dashes', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(recoveryCodeHash('ABCD-EFGH')).toBe(recoveryCodeHash('abcdefgh'));
    expect(recoveryCodeHash('abcd-efgh')).not.toBe(recoveryCodeHash('abcd-efgj'));
  });
});
