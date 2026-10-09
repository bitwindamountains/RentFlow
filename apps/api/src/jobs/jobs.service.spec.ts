import { describe, expect, it, vi } from 'vitest';
import { JobsService } from './jobs.service.js';

function jobs(acquire = vi.fn().mockResolvedValue(1), release = vi.fn().mockResolvedValue({ count: 1 })) {
  const service = new JobsService({ $executeRaw: acquire, jobLock: { updateMany: release } } as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, acquire, release };
}

describe('scheduled job lifecycle', () => {
  it('contains acquisition failures and allows another attempt', async () => {
    const { service, acquire } = jobs(vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(1));
    const run = vi.spyOn(service, 'runAll').mockResolvedValue({ organizations: 0, charges: 0, expired: 0 });
    expect(await service.tick()).toBeUndefined();
    expect(await service.tick()).toEqual({ organizations: 0, charges: 0, expired: 0 });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('finishes shutdown even when releasing the database lease fails', async () => {
    const { service } = jobs(undefined, vi.fn().mockRejectedValue(new Error('database unavailable')));
    vi.spyOn(service, 'runAll').mockRejectedValue(new Error('billing failed'));
    expect(await service.tick()).toBeUndefined();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('does not reenter while acquiring a lease or running, and stops after shutdown', async () => {
    let finish!: (value: number) => void;
    const { service, acquire } = jobs(vi.fn(() => new Promise<number>(resolve => { finish = resolve; })));
    const run = vi.spyOn(service, 'runAll').mockResolvedValue({ organizations: 0, charges: 0, expired: 0 });
    const first = service.tick();
    expect(await service.tick()).toBeUndefined();
    expect(acquire).toHaveBeenCalledTimes(1);
    finish(1);
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
    expect(await service.tick()).toBeUndefined();
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
