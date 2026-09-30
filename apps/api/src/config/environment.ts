type Environment = 'development' | 'test' | 'production';

export interface AppEnvironment {
  NODE_ENV: Environment;
  PORT: number;
  WEB_ORIGIN: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  LOG_LEVEL: string;
}

const allowedEnvironments = new Set<Environment>([
  'development',
  'test',
  'production',
]);

export function validateEnvironment(
  input: Record<string, unknown>,
): AppEnvironment {
  const nodeEnv = String(input['NODE_ENV'] ?? 'development') as Environment;
  const port = Number(input['PORT'] ?? 3000);
  const webOrigin = String(input['WEB_ORIGIN'] ?? 'http://localhost:4200');
  const databaseUrl = String(input['DATABASE_URL'] ?? '');
  const redisUrl = String(input['REDIS_URL'] ?? 'redis://localhost:6379');
  const logLevel = String(input['LOG_LEVEL'] ?? 'info');

  if (!allowedEnvironments.has(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (!databaseUrl && nodeEnv === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  if (nodeEnv === 'production' && input['USE_IN_MEMORY_STORE'] === 'true') {
    throw new Error('USE_IN_MEMORY_STORE is forbidden in production');
  }
  for (const origin of webOrigin.split(',')) {
    try {
      const url = new URL(origin.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid WEB_ORIGIN: ${origin}`);
    }
  }

  return {
    NODE_ENV: nodeEnv,
    PORT: port,
    WEB_ORIGIN: webOrigin,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    LOG_LEVEL: logLevel,
  };
}
