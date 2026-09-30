import { describe, expect, it, vi } from 'vitest';
import { OperationsService } from './operations.service.js';

describe('lease termination date safety', () => {
  it('rejects future termination before changing occupancy or billing', async () => {
    const update = vi.fn();
    const tx = {
      lease: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ startDate: new Date('2020-01-01') }),
        update,
      },
      organization: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ timezone: 'Asia/Manila' }),
      },
    };
    const service = new OperationsService({
      $transaction: (callback: any) => callback(tx),
    } as any);
    await expect(
      service.terminateLease('org', 'actor', 'lease', {
        endDate: '2999-01-01',
      }),
    ).rejects.toThrow('FUTURE_TERMINATION_NOT_ALLOWED');
    expect(update).not.toHaveBeenCalled();
  });
});
