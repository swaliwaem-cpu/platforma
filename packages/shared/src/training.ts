export type TrainingProjectStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type TrainingQuestionType = 'MAIN' | 'FOLLOW_UP';
export type TrainingAttemptStatus =
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'REQUIRES_REVIEW'
  | 'TIMED_OUT';
export type TrainingAttemptCompletionReason = 'COMPLETED' | 'TIMEOUT' | null;
export type TrainingConfirmedStatus = 'PASSED' | 'FAILED';
export type TrainingEmployeeProjectStatus = TrainingConfirmedStatus | 'REQUIRES_REVIEW' | null;
export type TrainingProjectEligibility =
  | 'ACTIVE_ATTEMPT'
  | 'ELIGIBLE'
  | 'PASSED'
  | 'LIMIT_REACHED'
  | 'CLOSED';

export type TrainingSafeBreakdown = {
  version: string;
  basis: 'TEXT_LENGTH' | 'FAKE_PASS' | 'FAKE_FAIL' | 'FAKE_REVIEW';
  awardedScore: number;
  maxScore: number;
};

export type TrainingAdminProjectSummary = {
  id: string;
  title: string;
  status: TrainingProjectStatus;
  isOpen: boolean;
  sortOrder: number;
  attemptLimit: number;
  timeLimitSeconds: number;
  passScore: number;
  questionsCount: number;
  attemptsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TrainingAdminProjectsResponse = {
  items: TrainingAdminProjectSummary[];
};

export type TrainingAdminProject = {
  id: string;
  realEstateObjectId: string | null;
  title: string;
  description: string | null;
  status: TrainingProjectStatus;
  isOpen: boolean;
  sortOrder: number;
  attemptLimit: number;
  timeLimitSeconds: number;
  passScore: number;
  allowRetakeAfterPass: boolean;
  mainQuestion: string;
  followUpQuestions: string[];
  createdAt: string;
  updatedAt: string;
};

export type CreateTrainingProjectRequest = {
  title: string;
  description?: string | null;
  realEstateObjectId?: string | null;
  sortOrder?: number;
  attemptLimit?: number;
  timeLimitMinutes?: number;
  passScore?: number;
  allowRetakeAfterPass: boolean;
};

export type UpdateTrainingProjectRequest = Required<CreateTrainingProjectRequest> & {
  mainQuestion: string;
  followUpQuestions: string[];
};

export type UpdateTrainingProjectAvailabilityRequest = {
  isOpen: boolean;
};

export type TrainingEmployeeProject = {
  id: string;
  title: string;
  description: string | null;
  attemptLimit: number;
  timeLimitSeconds: number;
  passScore: number;
  attemptsUsed: number;
  attemptsLeft: number;
  eligibility: TrainingProjectEligibility;
  canStart: boolean;
  activeAttempt: { id: string; expiresAt: string } | null;
  bestConfirmedScore: number | null;
  bestConfirmedStatus: TrainingConfirmedStatus | null;
  hasPendingReview: boolean;
  status: TrainingEmployeeProjectStatus;
};

export type TrainingEmployeeProjectsResponse = {
  items: TrainingEmployeeProject[];
};

export type TrainingAttemptQuestion = {
  id: string;
  sequence: number;
  type: TrainingQuestionType;
  text: string;
  maxScore: number;
};

export type TrainingEmployeeAttempt = {
  id: string;
  project: { id: string; title: string };
  attemptNumber: number;
  status: TrainingAttemptStatus;
  completionReason: TrainingAttemptCompletionReason;
  startedAt: string;
  expiresAt: string;
  completedAt: string | null;
  answeredCount: number;
  totalQuestions: number;
  currentQuestion: TrainingAttemptQuestion | null;
  result: {
    status: TrainingAttemptStatus;
    finalScore: number | null;
    isPassed: boolean | null;
    safeBreakdown: Array<{
      sequence: number;
      type: TrainingQuestionType;
      score: number;
      maxScore: number;
      details: TrainingSafeBreakdown;
    }>;
  } | null;
};

export type TrainingEmployeeAttemptSummary = {
  id: string;
  projectId: string;
  projectTitle: string;
  attemptNumber: number;
  status: TrainingAttemptStatus;
  finalScore: number | null;
  isPassed: boolean | null;
  startedAt: string;
  completedAt: string | null;
};

export type TrainingEmployeeAttemptsResponse = {
  items: TrainingEmployeeAttemptSummary[];
};

export type StartTrainingAttemptRequest = { confirmed: true };
export type SubmitTrainingAnswerRequest = { attemptQuestionId: string; text: string };

export type TrainingAdminAttemptSummary = {
  id: string;
  user: { id: string; email: string; name: string | null };
  project: { id: string; title: string };
  attemptNumber: number;
  status: TrainingAttemptStatus;
  finalScore: number | null;
  isPassed: boolean | null;
  startedAt: string;
  completedAt: string | null;
};

export type TrainingAdminAttemptsResponse = {
  items: TrainingAdminAttemptSummary[];
};

export type TrainingAdminAttempt = TrainingAdminAttemptSummary & {
  project: {
    id: string;
    title: string;
    settings: {
      attemptLimit: number;
      timeLimitSeconds: number;
      passScore: number;
      allowRetakeAfterPass: boolean;
    };
  };
  completionReason: TrainingAttemptCompletionReason;
  fakeEvaluationVersion: string;
  expiresAt: string;
  questions: Array<{
    id: string;
    sourceQuestionId: string | null;
    sequence: number;
    type: TrainingQuestionType;
    text: string;
    maxScore: number;
    status: 'PRESENTED' | 'ANSWERED' | 'SKIPPED_TIMEOUT';
    presentedAt: string;
    answeredAt: string | null;
    answer: {
      text: string;
      score: number;
      fakeOutcome: 'SCORED' | 'REQUIRES_REVIEW';
      safeBreakdown: TrainingSafeBreakdown;
      submittedAt: string;
    } | null;
  }>;
};
