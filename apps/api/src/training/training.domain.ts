import type {
  TrainingAttemptStatus,
  TrainingVersionStatus,
} from '@prisma/client';

export const TRAINING_MAIN_QUESTION_COUNT = 1;
export const TRAINING_FOLLOW_UP_POOL_SIZE = 10;
export const TRAINING_SELECTED_FOLLOW_UP_COUNT = 3;
export const TRAINING_ATTEMPT_QUESTION_COUNT = 4;
export const TRAINING_MAIN_MAX_SCORE = 55;
export const TRAINING_FOLLOW_UP_MAX_SCORE = 15;
export const TRAINING_TOTAL_MAX_SCORE = 100;

export const TRAINING_ACTIVE_ATTEMPT_STATUSES = [
  'STARTED',
  'AWAITING_MAIN',
  'PROCESSING_MAIN',
  'AWAITING_FOLLOW_UP',
  'PROCESSING_FOLLOW_UP',
  'FINALIZING',
] as const satisfies readonly TrainingAttemptStatus[];

export const TRAINING_IMMUTABLE_VERSION_STATUSES = [
  'PUBLISHED',
  'SUPERSEDED',
] as const satisfies readonly TrainingVersionStatus[];
