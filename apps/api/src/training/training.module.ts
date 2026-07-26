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

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [TrainingController, TrainingAdminController],
  providers: [
    TrainingConfigService,
    TrainingContentService,
    TrainingDocumentsService,
    TrainingDocumentWorkerService,
    TrainingAttemptEngineService,
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
  exports: [TrainingAttemptEngineService],
})
export class TrainingModule {}
