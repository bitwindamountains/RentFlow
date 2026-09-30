import { Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';

// Local development convenience; production receives real environment variables.
if (existsSync('.env')) process.loadEnvFile('.env');

const { environment } = await import('./config/environment.js');
const env = environment();
const { createApp } = await import('./bootstrap.js');
const app = await createApp();
await app.listen(env.PORT, '0.0.0.0');
new Logger('Bootstrap').log(`RentFlow API listening on :${env.PORT} (${env.NODE_ENV})`);
