import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AssistantSourcesModule } from './assistant/sources/assistant-sources.module';
import { isAssistantSourceWorkerRunnable } from './assistant/sources/assistant-source.worker';

async function bootstrap() {
  if (!isAssistantSourceWorkerRunnable()) {
    throw new Error('ASSISTANT_SOURCE_WORKER_AND_EXTERNAL_CONNECTORS_ENABLED_REQUIRED');
  }
  const application = await NestFactory.createApplicationContext(AssistantSourcesModule);
  application.enableShutdownHooks(['SIGTERM', 'SIGINT']);
}

void bootstrap();
