import { Module } from '@nestjs/common';

import { FilesModule } from '../../files/files.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TrainingTelegramConfig } from '../telegram/training-telegram.config';
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
    TrainingAudioConfig,
    TrainingTelegramConfig,
    FakeTrainingTelegramAudioProvider,
    NodeTrainingAudioProcessRunner,
    TrainingFfmpegService,
    TrainingAudioWorkerService,
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
