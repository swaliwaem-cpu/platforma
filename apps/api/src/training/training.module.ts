import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TrainingAdminController } from './training-admin.controller';
import { TrainingConfigController } from './training-config.controller';
import { TrainingAudioAccessController } from './training-audio-access.controller';
import { TrainingAudioAccessService } from './training-audio-access.service';
import {
  SpawnTrainingFfmpegRunner,
  TRAINING_FFMPEG_RUNNER,
  TrainingAudioService,
} from './training-audio.service';
import { TrainingAttemptStateService } from './training-attempt-state.service';
import { TrainingAttemptService } from './training-attempt.service';
import { TrainingEmployeeController } from './training-employee.controller';
import {
  DeterministicFakeTrainingEvaluator,
  TRAINING_EVALUATOR,
} from './training-evaluator';
import { OpenAITrainingEvaluator } from './training-openai-evaluator';
import {
  getOpenAIApiKey,
  getTrainingAiMode,
  TrainingOpenAIClient,
} from './training-openai-client';
import { OpenAITrainingTranscriber } from './training-openai-transcriber';
import { TrainingFollowUpSelector } from './training-follow-up-selector';
import { TrainingMaterialController } from './training-material.controller';
import { TrainingMaterialExtractionService } from './training-material-extraction';
import { TrainingMaterialService } from './training-material.service';
import {
  DeterministicFakeTrainingMaterialSuggester,
  OpenAITrainingMaterialSuggester,
  TRAINING_MATERIAL_SUGGESTER,
} from './training-material-suggester';
import { TrainingProjectService } from './training-project.service';
import { TrainingProjectKnowledgeService } from './training-project-knowledge.service';
import { TrainingProjectAccessService } from './training-project-access.service';
import { TrainingReviewService } from './training-review.service';
import { TrainingFeatureGuard } from './training-runtime-config';
import { TrainingResultsService } from './training-results.service';
import { TrainingRankingService } from './training-ranking.service';
import {
  FakeTrainingTelegramClient,
  getTrainingTelegramTransportMode,
  NativeTrainingTelegramClient,
  TRAINING_TELEGRAM_CLIENT,
  validateTrainingTelegramRealConfig,
} from './training-telegram-client';
import { TrainingTelegramController } from './training-telegram.controller';
import { TrainingTelegramService } from './training-telegram.service';
import {
  DeterministicFakeTrainingTranscriber,
  TRAINING_TRANSCRIBER,
} from './training-transcriber';
import { TrainingVoiceWorkerService } from './training-voice-worker.service';
import { TrainingUrlExtractor } from './training-url-extractor';

@Module({
  imports: [AuthModule, PrismaModule, FilesModule],
  controllers: [
    TrainingConfigController,
    TrainingEmployeeController,
    TrainingAdminController,
    TrainingAudioAccessController,
    TrainingMaterialController,
    TrainingTelegramController,
  ],
  providers: [
    TrainingProjectService,
    TrainingProjectAccessService,
    TrainingAttemptService,
    TrainingAttemptStateService,
    TrainingReviewService,
    TrainingResultsService,
    TrainingRankingService,
    TrainingAudioAccessService,
    TrainingFeatureGuard,
    TrainingFollowUpSelector,
    TrainingTelegramService,
    TrainingAudioService,
    TrainingVoiceWorkerService,
    TrainingMaterialExtractionService,
    TrainingUrlExtractor,
    TrainingMaterialService,
    TrainingProjectKnowledgeService,
    DeterministicFakeTrainingMaterialSuggester,
    SpawnTrainingFfmpegRunner,
    DeterministicFakeTrainingTranscriber,
    DeterministicFakeTrainingEvaluator,
    FakeTrainingTelegramClient,
    NativeTrainingTelegramClient,
    {
      provide: TRAINING_TELEGRAM_CLIENT,
      inject: [FakeTrainingTelegramClient, NativeTrainingTelegramClient],
      useFactory: (
        fakeClient: FakeTrainingTelegramClient,
        realClient: NativeTrainingTelegramClient,
      ) => {
        validateTrainingTelegramRealConfig();

        return getTrainingTelegramTransportMode() === 'real' ? realClient : fakeClient;
      },
    },
    {
      provide: TRAINING_EVALUATOR,
      inject: [DeterministicFakeTrainingEvaluator],
      useFactory: (fakeEvaluator: DeterministicFakeTrainingEvaluator) =>
        getTrainingAiMode() === 'openai'
          ? new OpenAITrainingEvaluator(new TrainingOpenAIClient(getOpenAIApiKey()))
          : fakeEvaluator,
    },
    {
      provide: TRAINING_FFMPEG_RUNNER,
      useExisting: SpawnTrainingFfmpegRunner,
    },
    {
      provide: TRAINING_MATERIAL_SUGGESTER,
      inject: [DeterministicFakeTrainingMaterialSuggester],
      useFactory: (fakeSuggester: DeterministicFakeTrainingMaterialSuggester) =>
        getTrainingAiMode() === 'openai'
          ? new OpenAITrainingMaterialSuggester(new TrainingOpenAIClient(getOpenAIApiKey()))
          : fakeSuggester,
    },
    {
      provide: TRAINING_TRANSCRIBER,
      inject: [DeterministicFakeTrainingTranscriber],
      useFactory: (fakeTranscriber: DeterministicFakeTrainingTranscriber) =>
        getTrainingAiMode() === 'openai'
          ? new OpenAITrainingTranscriber(new TrainingOpenAIClient(getOpenAIApiKey()))
          : fakeTranscriber,
    },
  ],
})
export class TrainingModule {}
