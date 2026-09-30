import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('AppController', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env['USE_IN_MEMORY_STORE'] = 'true';
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  it('reports the service name', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('RentFlow API');
  });

  afterAll(async () => {
    await app.close();
    delete process.env['USE_IN_MEMORY_STORE'];
  });
});
