import type {
  TrainingAnswerStatus,
  TrainingAttemptStatus,
  TrainingAttemptQuestionStatus,
  TrainingEmployeeBreakdownStatus,
  TrainingFactVerdict,
  TrainingPassStatus,
  TrainingProjectEligibilityReason,
  TrainingQuestionType,
  TrainingReviewStatus,
} from '@platforma/shared';

export const attemptStatusLabels: Record<TrainingAttemptStatus, string>;
export const passStatusLabels: Record<TrainingPassStatus, string>;
export const reviewStatusLabels: Record<TrainingReviewStatus, string>;
export const questionTypeLabels: Record<TrainingQuestionType, string>;
export const questionStatusLabels: Record<TrainingAttemptQuestionStatus, string>;
export const answerStatusLabels: Record<TrainingAnswerStatus, string>;
export const factVerdictLabels: Record<TrainingFactVerdict, string>;
export const employeeBreakdownStatusLabels: Record<
  TrainingEmployeeBreakdownStatus,
  string
>;
export const eligibilityLabels: Record<TrainingProjectEligibilityReason, string>;

export function visibleEmployeeScore(attempt: {
  reviewStatus: TrainingReviewStatus;
  finalScore: string | null;
}): string | null;

export function formatTrainingScore(value: string | number | null | undefined): string;
export function formatTrainingDuration(seconds: number | null | undefined): string;
export function readTrainingError(error: unknown, fallback: string): string;
export function formatTrainingPoints(value: number): string;
