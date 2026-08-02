export type TrainingProjectStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type TrainingQuestionType = 'MAIN' | 'FOLLOW_UP';
export type TrainingAttemptStatus =
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'REQUIRES_REVIEW'
  | 'TIMED_OUT'
  | 'TECHNICAL_FAILED';
export type TrainingAttemptCompletionReason =
  | 'COMPLETED'
  | 'TIMEOUT'
  | 'TECHNICAL_FAILURE'
  | null;
export type TrainingConfirmedStatus = 'PASSED' | 'FAILED';
export type TrainingReviewStatus = 'NOT_REQUIRED' | 'PENDING' | 'RESOLVED';
export type TrainingReviewDecision = 'APPROVED' | 'OVERRIDDEN' | null;
export type TrainingEmployeeProjectStatus = TrainingConfirmedStatus | 'REQUIRES_REVIEW' | null;
export type TrainingProjectEligibility =
  | 'ACTIVE_ATTEMPT'
  | 'ELIGIBLE'
  | 'PASSED'
  | 'LIMIT_REACHED'
  | 'CLOSED';

export type TrainingLegacySafeBreakdown = {
  version: string;
  basis: 'TEXT_LENGTH' | 'FAKE_PASS' | 'FAKE_FAIL' | 'FAKE_REVIEW';
  awardedScore: number;
  maxScore: number;
};

export type TrainingAiSafeBreakdown = {
  version: 'training-v2-evaluation-v1';
  basis: 'AI_CRITERIA';
  criteriaPoints: number;
  incorrectFactCount: number;
  penaltyPoints: number;
  awardedScore: number;
  maxScore: number;
};

export type TrainingSafeBreakdown = TrainingLegacySafeBreakdown | TrainingAiSafeBreakdown;

export type TrainingObjectiveMetrics = {
  audioDurationSeconds: number;
  segmentCount: number;
  wordCount: number;
  wordsPerMinute: number;
  fillerWordsCount: number;
  fillerWordsFound: string[];
};

export type TrainingStructuredEvaluation = {
  schema_version: 'training-v2-evaluation-v1';
  fact_assessments: Array<{
    fact_id: string;
    verdict: 'CORRECT' | 'PARTIAL' | 'MISSING' | 'INCORRECT';
    evidence: string | null;
    explanation: string;
  }>;
  criterion_assessments: Array<{
    criterion_id: string;
    awarded_points: number;
    evidence: string | null;
    explanation: string;
  }>;
  unsupported_claims: Array<{ claim: string; evidence: string }>;
  summary: string;
  requires_review: boolean;
};

export type TrainingFactDraft = {
  id: string | null;
  questionType: TrainingQuestionType;
  questionPosition: number;
  statement: string;
  aliases: string[];
  isRequired: boolean;
  position: number;
};

export type TrainingCriterionDraft = {
  id: string | null;
  questionType: TrainingQuestionType;
  code: string;
  title: string;
  guidance: string;
  maxPoints: number;
  position: number;
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
  contentSchemaVersion: number;
  mainQuestion: string;
  followUpQuestions: string[];
  facts: TrainingFactDraft[];
  criteria: TrainingCriterionDraft[];
  publicationErrors: string[];
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
  facts: TrainingFactDraft[];
  criteria: TrainingCriterionDraft[];
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

export type TrainingTelegramAccountState = {
  linked: boolean;
  username: string | null;
  linkedAt: string | null;
};

export type TrainingTelegramLinkResponse = {
  url: string;
  expiresAt: string;
  account: TrainingTelegramAccountState;
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
    message: string | null;
    attemptRefunded: boolean;
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
  calculatedScore: number | null;
  reviewStatus: TrainingReviewStatus;
  reviewDecision: TrainingReviewDecision;
  reviewedAt: string | null;
  reviewComment: string | null;
  reviewFinalScore: number | null;
  countsTowardAttemptLimit: boolean;
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
    facts: Array<{
      id: string;
      statement: string;
      aliases: string[];
      required: boolean;
      position: number;
    }>;
    criteria: Array<{
      id: string;
      code: string;
      title: string;
      guidance: string;
      maxPoints: number;
      position: number;
    }>;
    answer: null | {
      processingStatus: 'COLLECTING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
      text: string | null;
      score: number | null;
      safeBreakdown: TrainingSafeBreakdown | null;
      submittedAt: string | null;
      transcriptionModel: string | null;
      evaluationModel: string | null;
      evaluation: TrainingStructuredEvaluation | null;
      objectiveMetrics: TrainingObjectiveMetrics | null;
      technicalErrorCode: string | null;
    };
  }>;
};

export type ReviewTrainingAttemptRequest = {
  decision: 'APPROVE' | 'OVERRIDE';
  finalScore?: number | null;
  comment?: string | null;
};

export type ReviewTrainingAttemptResponse = {
  attemptId: string;
  status: TrainingAttemptStatus;
  calculatedScore: number | null;
  finalScore: number | null;
  isPassed: boolean | null;
  reviewStatus: TrainingReviewStatus;
  reviewDecision: TrainingReviewDecision;
  reviewedAt: string | null;
};
