import type {
  TrainingAttemptStatus,
  TrainingEmployeeBreakdownStatus,
  TrainingPassStatus,
  TrainingProjectEligibilityReason,
  TrainingReviewStatus,
} from '@platforma/shared';

export const attemptStatusLabels: Record<TrainingAttemptStatus, string>;
export const passStatusLabels: Record<TrainingPassStatus, string>;
export const reviewStatusLabels: Record<TrainingReviewStatus, string>;
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
