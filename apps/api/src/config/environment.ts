import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export type Environment = 'development' | 'test' | 'production';
export type MailProvider = 'log' | 'resend' | 'smtp';
export type StorageDriver = 'local' | 's3';

export interface AppEnvironment {
  NODE_ENV: Environment;
  PORT: number;
  WEB_ORIGIN: string;
  APP_URL: string;
  DATABASE_URL: string;
  TRUST_PROXY: number;
  LOG_LEVEL: 'error' | 'warn' | 'log' | 'debug' | 'verbose';
  ENABLE_JOBS: boolean;
  MAIL_PROVIDER: MailProvider;
  MAIL_FROM: string;
  MAIL_ENCRYPTION_KEY: Buffer;
  RESEND_API_KEY: string;
  SMTP_URL: string;
  SESSION_ABSOLUTE_HOURS: number;
  SESSION_IDLE_MINUTES: number;
  STORAGE_DRIVER: StorageDriver;
  STORAGE_DIR: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
  UPLOAD_MAX_BYTES: number;
  STORAGE_QUOTA_BYTES: number;
  /** 32-byte key for encrypting authenticator secrets; null turns MFA setup off in production. */
  MFA_ENCRYPTION_KEY: Buffer | null;
}

const environments = new Set<Environment>(['development', 'test', 'production']);
const logLevels = new Set(['error', 'warn', 'log', 'debug', 'verbose']);
const mailProviders = new Set<MailProvider>(['log', 'resend', 'smtp']);

function integer(input: Record<string, unknown>, name: string, fallback: number, min: number, max: number) {
  const value = Number(input[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function origin(value: string, name: string): string {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(`Invalid ${name}: expected an HTTP(S) origin without credentials, path, query or fragment`);
  }
}

/**
 * Fails closed: nothing security-relevant is inferred from a missing value.
 * NODE_ENV and DATABASE_URL must always be set explicitly.
 */
export function validateEnvironment(input: Record<string, unknown>): AppEnvironment {
  const nodeEnv = String(input['NODE_ENV'] ?? '') as Environment;
  if (!environments.has(nodeEnv))
    throw new Error('NODE_ENV must be set to development, test, or production');
  const production = nodeEnv === 'production';

  const databaseUrl = String(input['DATABASE_URL'] ?? '');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  if ('USE_IN_MEMORY_STORE' in input)
    throw new Error('USE_IN_MEMORY_STORE has been removed; use PostgreSQL');

  const origins = String(input['WEB_ORIGIN'] ?? (production ? '' : 'http://localhost:4200'))
    .split(',')
    .filter(Boolean)
    .map((item) => origin(item, 'WEB_ORIGIN'));
  if (!origins.length) throw new Error('WEB_ORIGIN is required in production');
  if (production && origins.some((item) => !item.startsWith('https://')))
    throw new Error('WEB_ORIGIN must use https in production');
  const appUrl = origin(String(input['APP_URL'] ?? origins[0]), 'APP_URL');
  if (production && !appUrl.startsWith('https://')) throw new Error('APP_URL must use https in production');

  const logLevel = String(input['LOG_LEVEL'] ?? (production ? 'log' : 'debug'));
  if (!logLevels.has(logLevel)) throw new Error('LOG_LEVEL must be error, warn, log, debug, or verbose');

  const mailProvider = String(input['MAIL_PROVIDER'] ?? 'log') as MailProvider;
  if (!mailProviders.has(mailProvider)) throw new Error('MAIL_PROVIDER must be log, resend, or smtp');
  if (production && mailProvider === 'log')
    throw new Error('MAIL_PROVIDER must be resend or smtp in production (password reset needs email)');
  const mailFrom = String(input['MAIL_FROM'] ?? 'RentFlow <no-reply@localhost>');
  const resendKey = String(input['RESEND_API_KEY'] ?? '');
  const smtpUrl = String(input['SMTP_URL'] ?? '');
  if (mailProvider === 'resend' && !resendKey) throw new Error('RESEND_API_KEY is required for MAIL_PROVIDER=resend');
  if (mailProvider === 'smtp' && !/^smtps?:\/\//.test(smtpUrl))
    throw new Error('SMTP_URL (smtp:// or smtps://) is required for MAIL_PROVIDER=smtp');
  if (production && mailProvider !== 'log' && !input['MAIL_FROM'])
    throw new Error('MAIL_FROM is required in production');

  const storageDriver = String(input['STORAGE_DRIVER'] ?? 'local') as StorageDriver;
  if (storageDriver !== 'local' && storageDriver !== 's3') throw new Error('STORAGE_DRIVER must be local or s3');
  // Uploaded tenant documents (IDs, leases) must live somewhere that is backed up, never in the container layer.
  if (production && storageDriver === 'local' && !isAbsolute(String(input['STORAGE_DIR'] ?? '')))
    throw new Error('STORAGE_DIR must be an absolute path on a persistent volume when STORAGE_DRIVER=local in production');
  const storageDir = String(input['STORAGE_DIR'] ?? '.data/uploads');
  const s3 = {
    bucket: String(input['S3_BUCKET'] ?? ''),
    region: String(input['S3_REGION'] ?? ''),
    endpoint: String(input['S3_ENDPOINT'] ?? ''),
    accessKeyId: String(input['S3_ACCESS_KEY_ID'] ?? ''),
    secretAccessKey: String(input['S3_SECRET_ACCESS_KEY'] ?? ''),
  };
  if (storageDriver === 's3') {
    if (!s3.bucket || !s3.region || !s3.accessKeyId || !s3.secretAccessKey)
      throw new Error('S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for STORAGE_DRIVER=s3');
    if (production && s3.endpoint && !s3.endpoint.startsWith('https://')) throw new Error('S3_ENDPOINT must use https in production');
  }

  const mfaKeyText = String(input['MFA_ENCRYPTION_KEY'] ?? '').trim();
  const mfaKey = mfaKeyText ? Buffer.from(mfaKeyText, 'base64') : null;
  if (mfaKey && mfaKey.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)');
  const mailKeyText = String(input['MAIL_ENCRYPTION_KEY'] ?? '').trim();
  if (production && !mailKeyText) throw new Error('MAIL_ENCRYPTION_KEY is required in production');
  const mailKey = mailKeyText ? Buffer.from(mailKeyText, 'base64') : createHash('sha256').update('rentflow-development-mail-key').digest();
  if (mailKey.length !== 32) throw new Error('MAIL_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');

  return {
    NODE_ENV: nodeEnv,
    PORT: integer(input, 'PORT', 3000, 1, 65_535),
    WEB_ORIGIN: origins.join(','),
    APP_URL: appUrl,
    DATABASE_URL: databaseUrl,
    TRUST_PROXY: integer(input, 'TRUST_PROXY', production ? 1 : 0, 0, 5),
    LOG_LEVEL: logLevel as AppEnvironment['LOG_LEVEL'],
    ENABLE_JOBS: String(input['ENABLE_JOBS'] ?? (nodeEnv === 'test' ? 'false' : 'true')) === 'true',
    MAIL_PROVIDER: mailProvider,
    MAIL_FROM: mailFrom,
    MAIL_ENCRYPTION_KEY: mailKey,
    RESEND_API_KEY: resendKey,
    SMTP_URL: smtpUrl,
    SESSION_ABSOLUTE_HOURS: integer(input, 'SESSION_ABSOLUTE_HOURS', 12, 1, 720),
    SESSION_IDLE_MINUTES: integer(input, 'SESSION_IDLE_MINUTES', 120, 5, 43_200),
    STORAGE_DRIVER: storageDriver,
    STORAGE_DIR: storageDir,
    S3_BUCKET: s3.bucket,
    S3_REGION: s3.region,
    S3_ENDPOINT: s3.endpoint,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    S3_FORCE_PATH_STYLE: String(input['S3_FORCE_PATH_STYLE'] ?? 'false') === 'true',
    UPLOAD_MAX_BYTES: integer(input, 'UPLOAD_MAX_MB', 10, 1, 50) * 1_048_576,
    STORAGE_QUOTA_BYTES: integer(input, 'STORAGE_QUOTA_MB', 2048, 10, 1_048_576) * 1_048_576,
    MFA_ENCRYPTION_KEY: mfaKey,
  };
}

let cached: AppEnvironment | undefined;

/** The validated environment for code that runs outside Nest's DI (bootstrap). */
export function environment(): AppEnvironment {
  cached ??= validateEnvironment(process.env);
  return cached;
}

export function resetEnvironmentCache(): void {
  cached = undefined;
}

export const sessionCookieName = () =>
  environment().NODE_ENV === 'production' ? '__Host-rentflow_session' : 'rentflow_session';
