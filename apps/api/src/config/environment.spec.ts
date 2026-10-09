import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { validateEnvironment } from './environment.js';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/rentflow',
  WEB_ORIGIN: 'https://app.example.com',
  MAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'RentFlow <billing@example.com>',
  MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  PRIVACY_CONTACT_EMAIL: 'privacy@example.com',
  STORAGE_DIR: '/data/uploads',
};

describe('validateEnvironment', () => {
  it('requires a 32-byte key for durable mail in production', () => {
    expect(() => validateEnvironment({ ...base, MAIL_ENCRYPTION_KEY: undefined })).toThrow('MAIL_ENCRYPTION_KEY');
    expect(() => validateEnvironment({ ...base, MAIL_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow('MAIL_ENCRYPTION_KEY');
  });
  it('accepts a complete production configuration with safe defaults', () => {
    expect(validateEnvironment(base)).toMatchObject({
      NODE_ENV: 'production',
      TRUST_PROXY: 1,
      ENABLE_JOBS: true,
      APP_URL: 'https://app.example.com',
    });
  });

  it('requires a 32-byte MFA key in production and makes it optional elsewhere', () => {
    expect(validateEnvironment(base).MFA_ENCRYPTION_KEY).toHaveLength(32);
    expect(() => validateEnvironment({ ...base, MFA_ENCRYPTION_KEY: undefined })).toThrow('MFA_ENCRYPTION_KEY is required');
    expect(validateEnvironment({ ...base, NODE_ENV: 'development', MFA_ENCRYPTION_KEY: undefined }).MFA_ENCRYPTION_KEY).toBeNull();
    expect(() => validateEnvironment({ ...base, MFA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow('MFA_ENCRYPTION_KEY');
  });

  it('requires a privacy contact email in production', () => {
    expect(() => validateEnvironment({ ...base, PRIVACY_CONTACT_EMAIL: undefined })).toThrow('PRIVACY_CONTACT_EMAIL is required');
    expect(() => validateEnvironment({ ...base, PRIVACY_CONTACT_EMAIL: 'not an email' })).toThrow('must be an email');
    expect(validateEnvironment({ ...base, NODE_ENV: 'development', PRIVACY_CONTACT_EMAIL: undefined }).PRIVACY_CONTACT_EMAIL).toBe('');
  });

  it('fails closed when NODE_ENV is missing instead of assuming development', () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: undefined })).toThrow('NODE_ENV must be set');
  });

  it('requires a PostgreSQL DATABASE_URL in every environment', () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'development', DATABASE_URL: '' })).toThrow('DATABASE_URL');
  });

  it('rejects the removed in-memory store', () => {
    expect(() => validateEnvironment({ ...base, USE_IN_MEMORY_STORE: 'true' })).toThrow('removed');
  });

  it('requires HTTPS origins and real email delivery in production', () => {
    expect(() => validateEnvironment({ ...base, WEB_ORIGIN: 'http://app.example.com' })).toThrow('https');
    expect(() => validateEnvironment({ ...base, APP_URL: 'http://app.example.com' })).toThrow('APP_URL must use https');
    expect(() => validateEnvironment({ ...base, MAIL_PROVIDER: 'log' })).toThrow('MAIL_PROVIDER');
    expect(() => validateEnvironment({ ...base, MAIL_PROVIDER: 'smtp' })).toThrow('SMTP_URL');
  });

  it('rejects malformed origins', () => {
    expect(() => validateEnvironment({ ...base, WEB_ORIGIN: 'javascript:alert(1)' })).toThrow('Invalid WEB_ORIGIN');
    expect(() => validateEnvironment({ ...base, APP_URL: 'https://user:password@app.example.com' })).toThrow('Invalid APP_URL');
    expect(() => validateEnvironment({ ...base, WEB_ORIGIN: 'https://app.example.com/#fragment' })).toThrow('Invalid WEB_ORIGIN');
  });

  it('requires uploads to live on a persistent absolute path or in S3 in production', () => {
    expect(validateEnvironment({ ...base, STORAGE_DIR: resolve('test-uploads') }).STORAGE_DRIVER).toBe('local');
    expect(() => validateEnvironment({ ...base, STORAGE_DIR: undefined })).toThrow('STORAGE_DIR');
    expect(() => validateEnvironment({ ...base, STORAGE_DIR: 'uploads' })).toThrow('STORAGE_DIR');
    expect(() => validateEnvironment({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'docs' })).toThrow('S3_REGION');
    expect(() =>
      validateEnvironment({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'docs', S3_REGION: 'auto', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://minio:9000' }),
    ).toThrow('https');
    expect(
      validateEnvironment({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'docs', S3_REGION: 'auto', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }),
    ).toMatchObject({ STORAGE_DRIVER: 's3', UPLOAD_MAX_BYTES: 10 * 1_048_576 });
    expect(() => validateEnvironment({ ...base, UPLOAD_MAX_MB: '500' })).toThrow('UPLOAD_MAX_MB');
  });
});
