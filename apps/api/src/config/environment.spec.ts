import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment.js';

describe('validateEnvironment', () => {
  it('forbids ephemeral storage in production even with a database configured', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
        USE_IN_MEMORY_STORE: 'true',
      }),
    ).toThrow('USE_IN_MEMORY_STORE is forbidden in production');
  });
  it('applies safe development defaults', () => {
    expect(validateEnvironment({})).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      WEB_ORIGIN: 'http://localhost:4200',
    });
  });

  it('requires a database URL in production', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_URL is required in production',
    );
  });

  it('rejects malformed origins', () => {
    expect(() =>
      validateEnvironment({ WEB_ORIGIN: 'javascript:alert(1)' }),
    ).toThrow('Invalid WEB_ORIGIN');
  });
});
