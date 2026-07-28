import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { TrainingAudioWorkerModule } from './audio/training-audio-worker.module';
import { assertTrainingDeploymentIsolation } from './training-deployment.config';

async function bootstrap() {
  assertTrainingDeploymentIsolation(process.env);
  const app = await NestFactory.createApplicationContext(
    TrainingAudioWorkerModule,
  );
  const keepAlive = setInterval(() => undefined, 60_000);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    await app.close();
  };

  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
}

void bootstrap();
