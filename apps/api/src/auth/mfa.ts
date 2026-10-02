import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { DomainError } from '../common/errors.js';
import { environment } from '../config/environment.js';

/** RFC 6238 defaults that every authenticator app supports. */
const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next step too, for clock drift between phone and server. */
const DRIFT_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Recovery codes avoid look-alike characters. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/** The code an authenticator shows for a base32 secret at a time step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(binary).padStart(DIGITS, '0');
}

/**
 * Checks a code within the drift window and returns the matched step. Steps at
 * or before `lastStep` are refused, so an observed code cannot be replayed.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const current = timeStep(now);
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (lastStep !== null && step <= lastStep) continue;
    if (totpCode(secret, step) === digits) return step;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = 'RentFlow'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// --------------------------------------------------------------- encryption
function key(): Buffer {
  const env = environment();
  if (env.MFA_ENCRYPTION_KEY) return env.MFA_ENCRYPTION_KEY;
  // Development and tests only; production must configure a real key to offer MFA.
  if (env.NODE_ENV !== 'production') return createHash('sha256').update('rentflow-development-mfa-key').digest();
  throw new DomainError('MFA_UNAVAILABLE', 503);
}

/** Throws MFA_UNAVAILABLE when no key is configured in production. */
export function assertMfaAvailable(): void {
  key();
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, body] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

// ----------------------------------------------------------- recovery codes
/** "abcd-efgh": 8 characters from a 31-letter alphabet, about 40 bits each. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 8 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

export function recoveryCodeHash(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return createHash('sha256').update(`rentflow-recovery:${normalized}`).digest('hex');
}

export function looksLikeRecoveryCode(code: string): boolean {
  return /^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code.trim());
}
