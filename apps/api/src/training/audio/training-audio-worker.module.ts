import { Module } from '@nestjs/common';

import { FilesModule } from '../../files/files.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TrainingTelegramConfig } from '../telegram/training-telegram.config';
import { TrainingConfigService } from '../training.config';
import { TrainingPolicyService } from '../training-policy.service';
import { TrainingWorkerHeartbeatService } from '../training-worker-heartbeat.service';
import { TrainingAttemptEngineService } from '../training-attempt-engine.service';
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
} from '../training-attempt.providers';
import { TrainingOpenAiConfig } from '../openai/training-openai.config';
import {
  createTrainingFactSuggestionProvider,
  DeterministicFakeTrainingFactSuggestionProvider,
  OpenAiTrainingFactSuggestionProvider,
  TRAINING_FACT_SUGGESTION_PROVIDER,
} from '../fact-suggestions/training-fact-suggestion.provider';
import { TrainingFactSuggestionWorkerService } from '../fact-suggestions/training-fact-suggestion-worker.service';
import { OpenAiTrainingEvaluationProvider } from '../openai/training-openai-evaluation.provider';
import {
  TrainingOpenAiHttpClient,
  TRAINING_OPENAI_HTTP_OPTIONS,
} from '../openai/training-openai.http';
import {
  createTrainingEvaluationProvider,
  createTrainingTranscriptionProvider,
} from '../openai/training-openai.providers';
import { OpenAiTrainingTranscriptionProvider } from '../openai/training-openai-transcription.provider';
import { TrainingOfficialUrlFetcher } from '../training-official-url-fetcher';
import { TrainingOfficialUrlWorkerService } from '../training-official-url-worker.service';
import { TrainingAudioConfig } from './training-audio.config';
import {
  TRAINING_AUDIO_PROCESS_RUNNER,
  NodeTrainingAudioProcessRunner,
} from './training-audio-process.runner';
import { TrainingAudioWorkerService } from './training-audio-worker.service';
import { TrainingFfmpegService } from './training-ffmpeg.service';
import {
  createTrainingTelegramAudioProvider,
  FakeTrainingTelegramAudioProvider,
  TRAINING_TELEGRAM_AUDIO_PROVIDER,
} from './training-telegram-audio.provider';

@Module({
  imports: [PrismaModule, FilesModule],
  providers: [
    TrainingConfigService,
    TrainingPolicyService,
    TrainingWorkerHeartbeatService,
    {
      provide: TrainingAudioConfig,
      useFactory: () => new TrainingAudioConfig(process.env),
    },
    {
      provide: TrainingTelegramConfig,
      useFactory: () => new TrainingTelegramConfig(process.env),
    },
    FakeTrainingTelegramAudioProvider,
    NodeTrainingAudioProcessRunner,
    TrainingFfmpegService,
    TrainingAudioWorkerService,
    TrainingOfficialUrlFetcher,
    TrainingOfficialUrlWorkerService,
    TrainingFactSuggestionWorkerService,
    TrainingAttemptEngineService,
    {
      provide: TrainingOpenAiConfig,
      useFactory: () => new TrainingOpenAiConfig(process.env),
    },
    TrainingOpenAiHttpClient,
    DeterministicFakeTrainingFactSuggestionProvider,
    OpenAiTrainingFactSuggestionProvider,
    OpenAiTrainingTranscriptionProvider,
    OpenAiTrainingEvaluationProvider,
    DeterministicFakeTrainingTranscriptionProvider,
    DeterministicFakeTrainingEvaluationProvider,
    {
      provide: TRAINING_OPENAI_HTTP_OPTIONS,
      useValue: {},
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
      provide: TRAINING_ATTEMPT_JOB_PROCESSOR_ENABLED,
      useValue: true,
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
    {
      provide: TRAINING_FACT_SUGGESTION_PROVIDER,
      inject: [
        TrainingOpenAiConfig,
        DeterministicFakeTrainingFactSuggestionProvider,
        OpenAiTrainingFactSuggestionProvider,
      ],
      useFactory: createTrainingFactSuggestionProvider,
    },
    {
      provide: TRAINING_AUDIO_PROCESS_RUNNER,
      useExisting: NodeTrainingAudioProcessRunner,
    },
    {
      provide: TRAINING_TELEGRAM_AUDIO_PROVIDER,
      inject: [
        TrainingTelegramConfig,
        TrainingAudioConfig,
        FakeTrainingTelegramAudioProvider,
      ],
      useFactory: createTrainingTelegramAudioProvider,
    },
  ],
})
export class TrainingAudioWorkerModule {}
