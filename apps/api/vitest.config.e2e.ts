import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      MAIL_PROVIDER: 'log',
      ENABLE_JOBS: 'false',
      RATE_LIMIT_MULTIPLIER: '1000',
      LOG_LEVEL: 'error',
      TRUST_PROXY: '1',
    },
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
