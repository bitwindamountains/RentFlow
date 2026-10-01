import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError } from './errors.js';

const scrypt = promisify(nodeScrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

// Verifying against this when an account does not exist keeps response time
// independent of whether the email is registered.
const dummyHash = hashPassword(randomToken());

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const [saltHex, hashHex] = (stored ?? (await dummyHash)).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual) && Boolean(stored);
}

export function assertPasswordPolicy(password: string, email: string): void {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH ||
    (local.length >= 4 && password.toLowerCase().includes(local))
  )
    throw new DomainError('PASSWORD_TOO_WEAK');
}

/** Deterministic JSON (sorted keys) for request fingerprints. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : item,
  );
}
