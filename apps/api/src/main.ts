import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { validateTrainingRuntimeConfig } from './training/training-runtime-config';

async function bootstrap() {
  validateTrainingRuntimeConfig();
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);

  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? true,
    credentials: true,
  });

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
