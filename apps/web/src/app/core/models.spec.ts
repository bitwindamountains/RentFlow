import { describe, expect, it } from 'vitest';
import { homeFor } from './models';

describe('homeFor', () => {
  it('sends each role to the area it can use', () => {
    expect(homeFor('TENANT')).toBe('/portal');
    expect(homeFor('MAINTENANCE')).toBe('/maintenance');
    expect(homeFor('OWNER')).toBe('/dashboard');
    expect(homeFor('VIEWER')).toBe('/dashboard');
    expect(homeFor(undefined)).toBe('/dashboard');
  });
});
