export type TrainingReviewSubmissionState =
  | 'IDLE'
  | 'SUBMITTING'
  | 'COMMITTED'
  | 'REFRESHING'
  | 'COMPLETED'
  | 'POST_AMBIGUOUS'
  | 'REFRESH_FAILED'
  | 'POST_FAILED';

export const TRAINING_REVIEW_SUBMISSION_STATES:
  readonly TrainingReviewSubmissionState[];

export type TrainingReviewOperation<T = unknown> = {
  key: string;
  payload: T;
  payloadHash: string;
};

export class TrainingReviewSubmission {
  constructor(uuid?: () => string);
  get state(): TrainingReviewSubmissionState;
  begin<T>(payload: T): TrainingReviewOperation<T>;
  retryAmbiguous<T>(): TrainingReviewOperation<T>;
  markCommitted(): void;
  markRefreshing(): void;
  markCompleted(): void;
  markPostAmbiguous(): void;
  markRefreshFailed(): void;
  markPostFailed(): void;
  reset(): void;
}
