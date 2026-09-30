import { type ArgumentsHost, BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ErrorFilter } from './error.filter.js';
import { DomainError } from './errors.js';

function host() {
  const send = vi.fn();
  const response = { status: vi.fn(() => ({ send })) };
  const value = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ id: 'req-1' }) }),
  } as unknown as ArgumentsHost;
  return { value, response, send };
}

describe('ErrorFilter', () => {
  it('maps domain errors to their status, code, and safe message', () => {
    const target = host();
    new ErrorFilter().catch(new DomainError('UNIT_OCCUPIED', 409), target.value);
    expect(target.response.status).toHaveBeenCalledWith(409);
    expect(target.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNIT_OCCUPIED' }));
  });

  it('reports validation failures with details', () => {
    const target = host();
    new ErrorFilter().catch(new BadRequestException(['amount must be an amount']), target.value);
    expect(target.send).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: 'VALIDATION_FAILED', details: ['amount must be an amount'] }),
    );
  });

  it('never leaks unexpected error messages and logs only stack frames', () => {
    const target = host();
    const filter = new ErrorFilter();
    const logger = (filter as unknown as { logger: { error: (value: unknown) => void } }).logger;
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    filter.catch(new Error('password=hunter2 in SQL'), target.value);
    const body = target.send.mock.calls[0]![0];
    expect(body).toMatchObject({ statusCode: 500, code: 'INTERNAL' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });
});
