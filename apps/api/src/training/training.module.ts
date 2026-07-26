import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { TrainingAdminController } from './training-admin.controller';
import { TrainingAttemptEngineService } from './training-attempt-engine.service';
import {
  CryptoTrainingQuestionSelector,
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
  SystemTrainingAttemptClock,
  TRAINING_ATTEMPT_CLOCK,
  TRAINING_EVALUATION_PROVIDER,
  TRAINING_QUESTION_SELECTOR,
  TRAINING_TRANSCRIPTION_PROVIDER,
} from './training-attempt.providers';
import { TrainingConfigService } from './training.config';
import { TrainingContentService } from './training-content.service';
import { TrainingController } from './training.controller';
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';
import {
  TrainingTelegramController,
  TrainingTelegramWebhookController,
} from './telegram/training-telegram.controller';
import { TrainingTelegramConfig } from './telegram/training-telegram.config';
import { TrainingTelegramDialogService } from './telegram/training-telegram-dialog.service';
import { TrainingTelegramLinkService } from './telegram/training-telegram-link.service';
import {
  createTrainingTelegramTransport,
  FakeTrainingTelegramTransport,
  TRAINING_TELEGRAM_TRANSPORT,
} from './telegram/training-telegram.transport';
import { TrainingTelegramWebhookService } from './telegram/training-telegram-webhook.service';
import { TrainingTelegramWorkerService } from './telegram/training-telegram-worker.service';

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [
    TrainingController,
    TrainingAdminController,
    TrainingTelegramController,
    TrainingTelegramWebhookController,
  ],
  providers: [
    TrainingConfigService,
    TrainingContentService,
    TrainingDocumentsService,
    TrainingDocumentWorkerService,
    TrainingAttemptEngineService,
    TrainingTelegramConfig,
    TrainingTelegramLinkService,
    TrainingTelegramDialogService,
    TrainingTelegramWebhookService,
    TrainingTelegramWorkerService,
    FakeTrainingTelegramTransport,
    {
      provide: TRAINING_TELEGRAM_TRANSPORT,
      inject: [TrainingTelegramConfig, FakeTrainingTelegramTransport],
      useFactory: createTrainingTelegramTransport,
    },
    {
      provide: TRAINING_ATTEMPT_CLOCK,
      useClass: SystemTrainingAttemptClock,
    },
    {
      provide: TRAINING_QUESTION_SELECTOR,
      useClass: CryptoTrainingQuestionSelector,
    },
    {
      provide: TRAINING_TRANSCRIPTION_PROVIDER,
      useClass: DeterministicFakeTrainingTranscriptionProvider,
    },
    {
      provide: TRAINING_EVALUATION_PROVIDER,
      useClass: DeterministicFakeTrainingEvaluationProvider,
    },
  ],
  exports: [
    TrainingAttemptEngineService,
    TrainingTelegramLinkService,
    TrainingTelegramWorkerService,
    FakeTrainingTelegramTransport,
  ],
})
export class TrainingModule {}
