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
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP-listed scrypt setting with a 16 MB memory cost, so concurrent sign-ins
// cannot exhaust a small server. Stored as `s2$<log2 N>$<r>$<p>$<salt>$<hash>`.
const CURRENT = { logN: 14, r: 8, p: 5 };
// Hashes from before versioning are `<salt>:<hash>` with Node's defaults.
const LEGACY = { logN: 14, r: 8, p: 1 };
// scrypt needs 128 * N * r bytes; this covers the largest accepted parameters (N=2^16, r=8).
const MAX_MEMORY = 128 * 2 ** 16 * 8 + 1_048_576;

const HEX = /^(?:[0-9a-f]{2})+$/;

function parseHash(stored: string) {
  const parts = stored.split('$');
  if (parts.length === 6 && parts[0] === 's2') {
    const [logN, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
    // Bounded so a bad stored value fails closed instead of exceeding MAX_MEMORY.
    if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 16 || r < 1 || r > 8 || p < 1 || p > 16) return null;
    const [salt, hash] = [parts[4]!, parts[5]!];
    return HEX.test(salt) && HEX.test(hash) ? { logN, r, p, salt, hash } : null;
  }
  const [salt, hash, extra] = stored.split(':');
  return salt && hash && extra === undefined && HEX.test(salt) && HEX.test(hash) ? { ...LEGACY, salt, hash } : null;
}

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
  const { logN, r, p } = CURRENT;
  const derived = await scrypt(password, salt, 64, { N: 2 ** logN, r, p, maxmem: MAX_MEMORY });
  return `s2$${logN}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** True when a stored hash uses older parameters and should be replaced at the next sign-in. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  return !parsed || parsed.logN !== CURRENT.logN || parsed.r !== CURRENT.r || parsed.p !== CURRENT.p;
}

// Verifying against this when an account does not exist keeps response time
// independent of whether the email is registered.
const dummyHash = hashPassword(randomToken());

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = parseHash(stored ?? (await dummyHash));
  if (!parsed) return false;
  const expected = Buffer.from(parsed.hash, 'hex');
  const actual = await scrypt(password, Buffer.from(parsed.salt, 'hex'), expected.length, {
    N: 2 ** parsed.logN,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEMORY,
  });
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
