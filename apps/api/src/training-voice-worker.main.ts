import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { TrainingModule } from './training/training.module';
import { validateTrainingRuntimeConfig } from './training/training-runtime-config';

async function bootstrap() {
  validateTrainingRuntimeConfig();

  if (process.env.TRAINING_VOICE_WORKER_ENABLED !== 'true') {
    throw new Error('TRAINING_VOICE_WORKER_ENABLED_REQUIRED');
  }

  const application = await NestFactory.createApplicationContext(TrainingModule);
  application.enableShutdownHooks(['SIGTERM', 'SIGINT']);
}

void bootstrap();
