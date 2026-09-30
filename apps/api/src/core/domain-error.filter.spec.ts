import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DomainErrorFilter } from './domain-error.filter.js';

describe('unexpected error logging', () => {
  it('logs diagnostic frames without exception secrets or request contents', () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const send = vi.fn();
    const status = vi.fn().mockReturnValue({ send });
    const error = new Error('database password=secret');
    error.stack =
      'Error: database password=secret\n    at handler (service.ts:10:2)';
    new DomainErrorFilter().catch(error, {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ id: 'request-1', body: { password: 'secret' } }),
      }),
    } as any);
    expect(status).toHaveBeenCalledWith(500);
    expect(log).toHaveBeenCalledWith({
      event: 'UNEXPECTED_REQUEST_ERROR',
      requestId: 'request-1',
      frames: ['    at handler (service.ts:10:2)'],
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain('secret');
    log.mockRestore();
  });
});
