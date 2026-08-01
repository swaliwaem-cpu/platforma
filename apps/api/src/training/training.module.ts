import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { TrainingAudioAccessService } from './audio/training-audio-access.service';
import { TrainingAudioConfig } from './audio/training-audio.config';
import { TrainingAudioController } from './audio/training-audio.controller';
import { TrainingAdminController } from './training-admin.controller';
import { TrainingAssignmentsController } from './training-assignments.controller';
import { TrainingAssignmentsService } from './training-assignments.service';
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
import { TrainingFactSuggestionsService } from './fact-suggestions/training-fact-suggestions.service';
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
import { TrainingFeatureGuard } from './training-feature.guard';
import { TrainingOperationsController } from './training-operations.controller';
import { TrainingOperationsService } from './training-operations.service';
import { TrainingOfficialUrlSourcesService } from './training-official-url-sources.service';
import { TrainingPolicyController } from './training-policy.controller';
import { TrainingPolicyService } from './training-policy.service';
import { TrainingWorkerHeartbeatService } from './training-worker-heartbeat.service';
import { TrainingReviewController } from './training-review.controller';
import {
  TrainingAdminResultsController,
  TrainingEmployeeResultsController,
} from './training-results.controller';
import { TrainingRankingService } from './training-ranking.service';
import { TrainingResultsService } from './training-results.service';
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';
import { TrainingLinkedObjectSourcesController } from './training-linked-object-sources.controller';
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
    TrainingAssignmentsController,
    TrainingLinkedObjectSourcesController,
    TrainingTelegramController,
    TrainingTelegramWebhookController,
    TrainingAudioController,
    TrainingReviewController,
    TrainingEmployeeResultsController,
    TrainingAdminResultsController,
    TrainingPolicyController,
    TrainingOperationsController,
  ],
  providers: [
    TrainingConfigService,
    TrainingFeatureGuard,
    TrainingPolicyService,
    TrainingOperationsService,
    TrainingWorkerHeartbeatService,
    TrainingContentService,
    TrainingAssignmentsService,
    TrainingDocumentsService,
    TrainingDocumentWorkerService,
    TrainingOfficialUrlSourcesService,
    TrainingFactSuggestionsService,
    {
      provide: TrainingAudioConfig,
      useFactory: () => new TrainingAudioConfig(process.env),
    },
    TrainingAudioAccessService,
    TrainingAttemptEngineService,
    TrainingResultsService,
    TrainingRankingService,
    {
      provide: TrainingOpenAiConfig,
      useFactory: () => new TrainingOpenAiConfig(process.env),
    },
    TrainingOpenAiHttpClient,
    OpenAiTrainingTranscriptionProvider,
    OpenAiTrainingEvaluationProvider,
    DeterministicFakeTrainingTranscriptionProvider,
    DeterministicFakeTrainingEvaluationProvider,
    {
      provide: TrainingTelegramConfig,
      useFactory: () => new TrainingTelegramConfig(process.env),
    },
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
  exports: [TrainingConfigService],
})
export class TrainingModule {}
