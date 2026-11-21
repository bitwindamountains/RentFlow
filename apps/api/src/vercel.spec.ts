import { describe, expect, it, vi } from 'vitest';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
const { originalUrl } = await import('./vercel.js');

describe('originalUrl', () => {
  it('restores the path the vercel.json rewrite moved into __path, keeping the query', () => {
    expect(originalUrl('/api?__path=v1%2Fauth%2Fme')).toBe('/api/v1/auth/me');
    expect(originalUrl('/api?__path=v1/payments&cursor=abc&limit=20')).toBe('/api/v1/payments?cursor=abc&limit=20');
  });

  it('leaves URLs the platform already passed through untouched', () => {
    expect(originalUrl('/api/v1/health/ready')).toBe('/api/v1/health/ready');
    expect(originalUrl('/api/v1/documents?__path=x')).toBe('/api/v1/documents?__path=x');
  });
});
