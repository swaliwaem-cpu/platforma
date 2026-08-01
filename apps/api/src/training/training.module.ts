import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TrainingAdminController } from './training-admin.controller';
import { TrainingAttemptStateService } from './training-attempt-state.service';
import { TrainingAttemptService } from './training-attempt.service';
import { TrainingEmployeeController } from './training-employee.controller';
import {
  DeterministicFakeTrainingEvaluator,
  TRAINING_EVALUATOR,
} from './training-evaluator';
import { TrainingFollowUpSelector } from './training-follow-up-selector';
import { TrainingProjectService } from './training-project.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [TrainingEmployeeController, TrainingAdminController],
  providers: [
    TrainingProjectService,
    TrainingAttemptService,
    TrainingAttemptStateService,
    TrainingFollowUpSelector,
    {
      provide: TRAINING_EVALUATOR,
      useClass: DeterministicFakeTrainingEvaluator,
    },
  ],
})
export class TrainingModule {}
