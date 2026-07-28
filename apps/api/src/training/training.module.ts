import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { TrainingAudioAccessService } from './audio/training-audio-access.service';
import { TrainingAudioConfig } from './audio/training-audio.config';
import { TrainingAudioController } from './audio/training-audio.controller';
import { TrainingAdminController } from './training-admin.controller';
import { TrainingAttemptEngineService } from './training-attempt-engine.service';
import {
  CryptoTrainingQuestionSelector,
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
  SystemTrainingAttemptClock,
  TRAINING_ATTEMPT_CLOCK,
  TRAINING_ATTEMPT_JOB_PROCESSOR_ENABLED,
  TRAINING_EVALUATION_PROVIDER,
  TRAINING_QUESTION_SELECTOR,
  TRAINING_TRANSCRIPTION_PROVIDER,
} from './training-attempt.providers';
import { TrainingOpenAiConfig } from './openai/training-openai.config';
import { OpenAiTrainingEvaluationProvider } from './openai/training-openai-evaluation.provider';
import {
  TrainingOpenAiHttpClient,
  TRAINING_OPENAI_HTTP_OPTIONS,
} from './openai/training-openai.http';
import {
  createTrainingEvaluationProvider,
  createTrainingTranscriptionProvider,
} from './openai/training-openai.providers';
import { OpenAiTrainingTranscriptionProvider } from './openai/training-openai-transcription.provider';
import { TrainingConfigService } from './training.config';
import { TrainingContentService } from './training-content.service';
import { TrainingController } from './training.controller';
import { TrainingReviewController } from './training-review.controller';
import {
  TrainingAdminResultsController,
  TrainingEmployeeResultsController,
} from './training-results.controller';
import { TrainingRankingService } from './training-ranking.service';
import { TrainingResultsService } from './training-results.service';
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
    TrainingAudioController,
    TrainingReviewController,
    TrainingEmployeeResultsController,
    TrainingAdminResultsController,
  ],
  providers: [
    TrainingConfigService,
    TrainingContentService,
    TrainingDocumentsService,
    TrainingDocumentWorkerService,
    TrainingAudioConfig,
    TrainingAudioAccessService,
    TrainingAttemptEngineService,
    TrainingResultsService,
    TrainingRankingService,
    TrainingOpenAiConfig,
    TrainingOpenAiHttpClient,
    OpenAiTrainingTranscriptionProvider,
    OpenAiTrainingEvaluationProvider,
    DeterministicFakeTrainingTranscriptionProvider,
    DeterministicFakeTrainingEvaluationProvider,
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
      provide: TRAINING_ATTEMPT_JOB_PROCESSOR_ENABLED,
      useValue: false,
    },
    {
      provide: TRAINING_OPENAI_HTTP_OPTIONS,
      useValue: {},
    },
    {
      provide: TRAINING_QUESTION_SELECTOR,
      useClass: CryptoTrainingQuestionSelector,
    },
    {
      provide: TRAINING_TRANSCRIPTION_PROVIDER,
      inject: [
        TrainingOpenAiConfig,
        DeterministicFakeTrainingTranscriptionProvider,
        OpenAiTrainingTranscriptionProvider,
      ],
      useFactory: createTrainingTranscriptionProvider,
    },
    {
      provide: TRAINING_EVALUATION_PROVIDER,
      inject: [
        TrainingOpenAiConfig,
        DeterministicFakeTrainingEvaluationProvider,
        OpenAiTrainingEvaluationProvider,
      ],
      useFactory: createTrainingEvaluationProvider,
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
