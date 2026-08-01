import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TrainingAdminController } from './training-admin.controller';
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
import { TrainingFollowUpSelector } from './training-follow-up-selector';
import { TrainingProjectService } from './training-project.service';
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

@Module({
  imports: [AuthModule, PrismaModule, FilesModule],
  controllers: [
    TrainingEmployeeController,
    TrainingAdminController,
    TrainingTelegramController,
  ],
  providers: [
    TrainingProjectService,
    TrainingAttemptService,
    TrainingAttemptStateService,
    TrainingFollowUpSelector,
    TrainingTelegramService,
    TrainingAudioService,
    TrainingVoiceWorkerService,
    SpawnTrainingFfmpegRunner,
    DeterministicFakeTrainingTranscriber,
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
      useClass: DeterministicFakeTrainingEvaluator,
    },
    {
      provide: TRAINING_FFMPEG_RUNNER,
      useExisting: SpawnTrainingFfmpegRunner,
    },
    {
      provide: TRAINING_TRANSCRIBER,
      useExisting: DeterministicFakeTrainingTranscriber,
    },
  ],
})
export class TrainingModule {}
