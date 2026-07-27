import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { TrainingAudioWorkerModule } from './audio/training-audio-worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(
    TrainingAudioWorkerModule,
  );
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
}

void bootstrap();
