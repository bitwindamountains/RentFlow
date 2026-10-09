import { describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { HealthController } from './health.controller.js';

describe('readiness', () => {
  const applied = readdirSync(new URL('../../prisma/migrations/', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => ({ migration_name: entry.name }));
  it('requires every migration shipped with this release', async () => {
    const query = vi.fn().mockResolvedValue(applied.slice(0, -1));
    const controller = new HealthController({ $queryRaw: query } as never);
    await expect(controller.ready()).rejects.toThrow();
    query.mockResolvedValue(applied);
    expect(await controller.ready()).toMatchObject({ status: 'ready' });
  });
  it('reports unavailable databases as not ready', async () => {
    const controller = new HealthController({ $queryRaw: vi.fn().mockRejectedValue(new Error('offline')) } as never);
    await expect(controller.ready()).rejects.toThrow();
  });
});
