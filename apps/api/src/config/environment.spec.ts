import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment.js';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/rentflow',
  WEB_ORIGIN: 'https://app.example.com',
  MAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'RentFlow <billing@example.com>',
};

describe('validateEnvironment', () => {
  it('accepts a complete production configuration with safe defaults', () => {
    expect(validateEnvironment(base)).toMatchObject({
      NODE_ENV: 'production',
      TRUST_PROXY: 1,
      ENABLE_JOBS: true,
      APP_URL: 'https://app.example.com',
    });
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
    expect(() => validateEnvironment({ ...base, MAIL_PROVIDER: 'log' })).toThrow('MAIL_PROVIDER');
    expect(() => validateEnvironment({ ...base, MAIL_PROVIDER: 'smtp' })).toThrow('SMTP_URL');
  });

  it('rejects malformed origins', () => {
    expect(() => validateEnvironment({ ...base, WEB_ORIGIN: 'javascript:alert(1)' })).toThrow('Invalid WEB_ORIGIN');
  });
});
