import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { type LogLevel, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module.js';
import { environment, sessionCookieName } from './config/environment.js';
import { UPLOAD_TYPES } from './storage/file-store.service.js';

const levels: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/**
 * Builds the fully configured application. Shared by `main.ts` and the e2e
 * tests so that tests exercise exactly the production pipeline.
 */
export async function createApp(options: { logger?: false } = {}): Promise<NestFastifyApplication> {
  const env = environment();
  const adapter = new FastifyAdapter({
    // Needed so request.ip is the client, not the reverse proxy, for rate limits.
    trustProxy: env.TRUST_PROXY ? (_address: string, hop: number) => hop < env.TRUST_PROXY : false,
    bodyLimit: 1_048_576,
    genReqId: (request: { headers: Record<string, string | string[] | undefined> }) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    logger: options.logger ?? levels.slice(0, levels.indexOf(env.LOG_LEVEL) + 1),
  });
  const production = env.NODE_ENV === 'production';

  await app.register(fastifyCookie);
  await app.register(helmet, {
    // The API only serves JSON/CSV; the web app's CSP is set by the web server.
    contentSecurityPolicy: production
      ? { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }
      : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await app.register(rateLimit, {
    global: true,
    max: () => 300 * Number(process.env['RATE_LIMIT_MULTIPLIER'] ?? 1),
    timeWindow: '1 minute',
    // Use the plugin's normalized IP key, including on public auth routes.
    // A caller-supplied cookie is not proof of an authenticated identity.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    }),
  });
  // Raw file bodies are accepted on the two upload routes only, up to UPLOAD_MAX_BYTES.
  const uploadRoute = /\/(documents\/files|portal\/payment-notices\/[0-9a-f-]{36}\/proof)$/;
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      Object.keys(UPLOAD_TYPES),
      { parseAs: 'buffer', bodyLimit: env.UPLOAD_MAX_BYTES },
      (request, body, done) => {
        if (!uploadRoute.test(request.url.split('?')[0]!)) {
          done(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }), undefined);
          return;
        }
        done(null, body);
      },
    );
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (request, reply) => {
      reply.header('x-request-id', request.id);
      if (!reply.getHeader('cache-control')) reply.header('cache-control', 'no-store');
    });

  app.enableCors({
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after', 'x-next-cursor'],
    origin: env.WEB_ORIGIN.split(','),
    maxAge: 600,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
      stopAtFirstError: true,
    }),
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
  app.enableShutdownHooks();

  if (env.NODE_ENV === 'development') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('RentFlow API')
        .setDescription('Rental operations and financial ledger API')
        .setVersion('1.0')
        .addCookieAuth(sessionCookieName())
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }
  return app;
}
