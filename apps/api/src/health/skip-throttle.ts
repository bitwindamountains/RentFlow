import { RouteConfig } from '@nestjs/platform-fastify';

/** Probes are polled by infrastructure and must not consume client quotas. */
export const SkipThrottle = () => RouteConfig({ rateLimit: false });
