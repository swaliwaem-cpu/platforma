export type TrainingModuleStatus = 'enabled' | 'disabled';

export type TrainingModuleConfigResponse = {
  enabled: boolean;
  status: TrainingModuleStatus;
};

export const TRAINING_PROJECT_STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'] as const;
export type TrainingProjectStatus = (typeof TRAINING_PROJECT_STATUSES)[number];

export const TRAINING_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const;
export type TrainingVersionStatus = (typeof TRAINING_VERSION_STATUSES)[number];

export const TRAINING_QUESTION_TYPES = ['MAIN', 'FOLLOW_UP'] as const;
export type TrainingQuestionType = (typeof TRAINING_QUESTION_TYPES)[number];

export const TRAINING_ATTEMPT_STATUSES = [
  'STARTED',
  'AWAITING_MAIN',
  'PROCESSING_MAIN',
  'AWAITING_FOLLOW_UP',
  'PROCESSING_FOLLOW_UP',
  'FINALIZING',
  'COMPLETED',
  'REQUIRES_REVIEW',
  'EXPIRED',
  'TECHNICAL_FAILURE',
] as const;
export type TrainingAttemptStatus = (typeof TRAINING_ATTEMPT_STATUSES)[number];

export const TRAINING_ATTEMPT_QUESTION_STATUSES = [
  'PENDING',
  'PRESENTED',
  'COLLECTING',
  'LOCKED',
  'PROCESSING',
  'SCORED',
  'SKIPPED_TIMEOUT',
] as const;
export type TrainingAttemptQuestionStatus = (typeof TRAINING_ATTEMPT_QUESTION_STATUSES)[number];

export const TRAINING_ANSWER_STATUSES = [
  'COLLECTING',
  'READY',
  'DOWNLOADING',
  'TRANSCRIBING',
  'EVALUATING',
  'SCORED',
  'FAILED',
] as const;
export type TrainingAnswerStatus = (typeof TRAINING_ANSWER_STATUSES)[number];

export const TRAINING_FACT_VERDICTS = [
  'CORRECT',
  'PARTIAL',
  'MISSING',
  'INCORRECT',
  'UNSUPPORTED',
] as const;
export type TrainingFactVerdict = (typeof TRAINING_FACT_VERDICTS)[number];

export const TRAINING_REVIEW_STATUSES = [
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'OVERRIDDEN',
] as const;
export type TrainingReviewStatus = (typeof TRAINING_REVIEW_STATUSES)[number];

export const TRAINING_PASS_STATUSES = ['PENDING', 'PASSED', 'FAILED'] as const;
export type TrainingPassStatus = (typeof TRAINING_PASS_STATUSES)[number];

export const TRAINING_JOB_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD'] as const;
export type TrainingJobStatus = (typeof TRAINING_JOB_STATUSES)[number];

export const TRAINING_JOB_KINDS = [
  'PROCESS_TELEGRAM_UPDATE',
  'TELEGRAM_DOWNLOAD_SEGMENT',
  'ASSEMBLE_ANSWER_AUDIO',
  'CLEANUP_TRAINING_AUDIO_OBJECT',
  'TRANSCRIBE_ANSWER',
  'ANALYZE_ACOUSTICS',
  'EVALUATE_ANSWER',
  'FINALIZE_ATTEMPT',
  'SEND_TELEGRAM_MESSAGE',
  'SEND_TIMER_WARNING',
  'EXPIRE_ATTEMPT',
  'EXTRACT_SOURCE_DOCUMENT',
] as const;
export type TrainingJobKind = (typeof TRAINING_JOB_KINDS)[number];

export const TRAINING_SOURCE_EXTRACTION_STATUSES = [
  'PENDING',
  'PROCESSING',
  'READY',
  'NEEDS_MANUAL_TEXT',
  'FAILED',
] as const;
export type TrainingSourceExtractionStatus =
  (typeof TRAINING_SOURCE_EXTRACTION_STATUSES)[number];

export const TRAINING_SOURCE_DOCUMENT_TYPES = ['PDF', 'DOCX', 'PPTX', 'XLSX'] as const;
export type TrainingSourceDocumentType = (typeof TRAINING_SOURCE_DOCUMENT_TYPES)[number];

export const TRAINING_PROCESSED_UPDATE_STATUSES = [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
] as const;
export type TrainingProcessedUpdateStatus =
  (typeof TRAINING_PROCESSED_UPDATE_STATUSES)[number];

export type TrainingAttemptSettingsSnapshot = {
  versionId: string;
  versionNumber: number;
  passScore: number;
  attemptLimit: number;
  cooldownMinutes: number;
  totalTimeLimitSeconds: number;
  finishGraceSeconds: number;
  warningSeconds: number[];
  allowRetakeAfterPass: boolean;
  mainMaxScore: 55;
  followUpMaxScore: 15;
  promptVersion: string;
  schemaVersion: string;
};

export type TrainingQuestionSelection = {
  mainQuestionId: string;
  followUpQuestionIds: readonly [string, string, string];
};

export type TrainingScoreSnapshot = {
  aiScore: string | null;
  serverScore: string | null;
  adminScore: string | null;
  finalScore: string | null;
  passStatus: TrainingPassStatus;
  reviewStatus: TrainingReviewStatus;
};

export type TrainingPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type TrainingEmployeeAttemptFiltersQuery = {
  page?: number;
  pageSize?: number;
  projectId?: string;
  status?: TrainingAttemptStatus;
  dateFrom?: string;
  dateTo?: string;
};

export type TrainingAdminResultFiltersQuery = {
  page?: number;
  pageSize?: number;
  user?: string;
  userId?: string;
  projectId?: string;
  projectVersionId?: string;
  status?: TrainingAttemptStatus;
  reviewStatus?: TrainingReviewStatus;
  passStatus?: TrainingPassStatus;
  requiresReview?: boolean;
  dateFrom?: string;
  dateTo?: string;
  finalScoreFrom?: number;
  finalScoreTo?: number;
  sortField?: 'startedAt' | 'completedAt' | 'finalScore';
  sortDirection?: 'asc' | 'desc';
};

export type TrainingRankingFiltersQuery = {
  page?: number;
  pageSize?: number;
  user?: string;
  projectId?: string;
};

export type TrainingTelegramAccountSummary = {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  linkedAt: string;
};

export type TrainingTelegramAccountResponse = {
  connected: boolean;
  account: TrainingTelegramAccountSummary | null;
};

export type TrainingProjectEligibilityReason =
  | 'AVAILABLE'
  | 'TELEGRAM_NOT_CONNECTED'
  | 'ATTEMPT_IN_PROGRESS'
  | 'ATTEMPT_LIMIT_REACHED'
  | 'COOLDOWN_ACTIVE'
  | 'ALREADY_PASSED'
  | 'DEADLINE_PASSED'
  | 'NOT_YET_AVAILABLE';

export type TrainingEmployeeProjectSummary = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  object: {
    id: string;
    title: string;
    slug: string;
    summary: string | null;
  } | null;
  sortOrder: number;
  availableFrom: string | null;
  deadlineAt: string | null;
  passScore: number;
  attemptLimit: number;
  attemptsUsed: number;
  attemptsLeft: number;
  cooldownMinutes: number;
  totalTimeLimitSeconds: number;
  allowRetakeAfterPass: boolean;
  requiresTelegramConnection: boolean;
  telegramConnected: boolean;
  bestScore: string | null;
  lastScore: string | null;
  lastAttemptStatus: TrainingAttemptStatus | null;
  activeAttempt: {
    id: string;
    status: TrainingAttemptStatus;
    startedAt: string;
    expiresAt: string;
  } | null;
  eligibility: {
    canStart: boolean;
    reason: TrainingProjectEligibilityReason;
    retryAt: string | null;
  };
};

export type TrainingEmployeeProjectsResponse = {
  items: TrainingEmployeeProjectSummary[];
};

export type TrainingEmployeeAttemptListItem = {
  id: string;
  attemptNumber: number;
  status: TrainingAttemptStatus;
  isConsumed: boolean;
  startedAt: string;
  expiresAt: string;
  completedAt: string | null;
  totalDurationSeconds: number | null;
  finalScore: string | null;
  passStatus: TrainingPassStatus;
  reviewStatus: TrainingReviewStatus;
  project: {
    id: string;
    title: string;
    slug: string;
  };
};

export type TrainingEmployeeAttemptsResponse = {
  items: TrainingEmployeeAttemptListItem[];
  pagination: TrainingPagination;
};

export type TrainingEmployeeScoreComponent = {
  key: string;
  title: string;
  awardedPoints: string;
  maxPoints: string;
};

export const TRAINING_EMPLOYEE_BREAKDOWN_STATUSES = [
  'AVAILABLE',
  'PENDING_REVIEW',
  'MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE',
  'BREAKDOWN_UNAVAILABLE',
] as const;
export type TrainingEmployeeBreakdownStatus =
  (typeof TRAINING_EMPLOYEE_BREAKDOWN_STATUSES)[number];

export type TrainingEmployeeQuestionBreakdown = {
  id: string;
  sequence: number;
  type: TrainingQuestionType;
  text: string;
  status: TrainingAttemptQuestionStatus;
  responseTimeSeconds: number | null;
  answerDurationSeconds: number | null;
  score: string;
  components: TrainingEmployeeScoreComponent[];
};

export type TrainingEmployeeAttemptDetail = TrainingEmployeeAttemptListItem & {
  attemptsLeft: number;
  bestScore: string | null;
  breakdownStatus: TrainingEmployeeBreakdownStatus;
  breakdown: TrainingEmployeeQuestionBreakdown[] | null;
};

export type TrainingEmployeeAttemptDetailResponse = {
  attempt: TrainingEmployeeAttemptDetail;
};

export type TrainingAdminResultListItem = {
  id: string;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  project: {
    id: string;
    title: string;
    slug: string;
  };
  projectVersion: {
    id: string;
    versionNumber: number;
  };
  attemptNumber: number;
  status: TrainingAttemptStatus;
  isConsumed: boolean;
  startedAt: string;
  completedAt: string | null;
  totalDurationSeconds: number | null;
  aiScore: string | null;
  serverScore: string | null;
  adminScore: string | null;
  finalScore: string | null;
  passStatus: TrainingPassStatus;
  reviewStatus: TrainingReviewStatus;
  answerErrorsCount: number;
  unsupportedClaimsCount: number;
  answersCompleted: number;
  attemptsUsed: number;
  requiresReview: boolean;
  summary: string | null;
};

export type TrainingAdminResultsResponse = {
  items: TrainingAdminResultListItem[];
  pagination: TrainingPagination;
};

export type TrainingAdminProviderRun = {
  id: string;
  kind: string;
  runType: string;
  status: string;
  requestedModelId: string;
  actualModelId: string | null;
  requestId: string | null;
  responseStatus: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  rubricVersion: string | null;
  latencyMs: number | null;
  retryCount: number;
  errorCode: string | null;
  errorClass: string | null;
  ambiguousOutcome: boolean;
  usage: unknown;
  startedAt: string | null;
  completedAt: string | null;
};

export type TrainingAdminScoreComponent = {
  componentKey: string;
  title: string | null;
  criterionCode: string | null;
  factCode: string | null;
  awardedPoints: string;
  maxPoints: string;
  penaltyPoints: string;
  factVerdict: TrainingFactVerdict | null;
  evidence: unknown;
};

export type TrainingUnsupportedClaimDecision = {
  componentKey: string;
  decision: 'ACCEPTED' | 'INCORRECT';
};

export type TrainingAdminAnswerDetail = {
  id: string;
  status: TrainingAnswerStatus;
  audioAvailable: boolean;
  audioUrl: string | null;
  audioMimeType: string | null;
  audioSizeBytes: string | null;
  audioDurationMilliseconds: number | null;
  combinedTranscript: string | null;
  normalizedLanguage: string | null;
  transcriptionProvider: string | null;
  transcriptionModel: string | null;
  transcriptionRequestId: string | null;
  acousticMetrics: unknown;
  processingStartedAt: string | null;
  processingFinishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  segments: Array<{
    id: string;
    segmentIndex: number;
    mimeType: string | null;
    sizeBytes: string | null;
    durationMilliseconds: number | null;
    downloadedAt: string | null;
    receivedAt: string;
  }>;
  transcriptions: Array<{
    id: string;
    transcriptionNumber: number;
    transcript: string;
    language: string;
    wordCount: number;
    isActive: boolean;
    createdAt: string;
  }>;
  evaluations: Array<{
    id: string;
    evaluationNumber: number;
    actualModelId: string;
    reasoningEffort: string | null;
    promptVersion: string;
    schemaVersion: string;
    rubricVersion: string;
    aiSuggestedScore: string;
    serverScore: string;
    summary: string | null;
    requiresReview: boolean;
    reviewReasons: unknown;
    usage: unknown;
    latencyMs: number | null;
    requestId: string | null;
    isActive: boolean;
    components: TrainingAdminScoreComponent[];
    createdAt: string;
  }>;
  providerRuns: TrainingAdminProviderRun[];
};

export type TrainingAdminAttemptDetail = TrainingAdminResultListItem & {
  expiresAt: string;
  graceExpiresAt: string;
  aiScore: string | null;
  serverScore: string | null;
  adminScore: string | null;
  summary: string | null;
  timeline: Array<{
    at: string;
    kind: string;
    label: string;
  }>;
  questions: Array<{
    id: string;
    sequence: number;
    type: TrainingQuestionType;
    text: string;
    status: TrainingAttemptQuestionStatus;
    presentedAt: string | null;
    firstSegmentAt: string | null;
    finishedAt: string | null;
    responseTimeSeconds: number | null;
    answerDurationSeconds: number | null;
    answer: TrainingAdminAnswerDetail | null;
  }>;
  reviews: Array<{
    id: string;
    reviewNumber: number;
    reviewer: {
      id: string;
      name: string | null;
      email: string;
    };
    previousFinalScore: string | null;
    adminScore: string | null;
    finalScore: string;
    decision: TrainingReviewStatus;
    comment: string;
    unsupportedClaimsDecisions: unknown;
    reviewedAt: string;
  }>;
  jobs: Array<{
    id: string;
    kind: TrainingJobKind;
    status: TrainingJobStatus;
    attempts: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    runAt: string;
    finishedAt: string | null;
  }>;
};

export type TrainingAdminAttemptDetailResponse = {
  attempt: TrainingAdminAttemptDetail;
};

export type TrainingRankingProjectResult = {
  attemptId: string;
  attemptNumber: number;
  projectId: string;
  projectTitle: string;
  finalScore: string;
  passStatus: TrainingPassStatus;
  completedAt: string;
  attemptsUsed: number;
  summary: string | null;
  scoreChangeFromFirst: string | null;
  components: TrainingEmployeeScoreComponent[];
  errors: string[];
  unsupportedClaims: string[];
};

export type TrainingRankingItem = {
  position: number;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  passedProjectsCount: number;
  completedProjectsCount: number;
  averageBestScore: string | null;
  attemptsUsed: number;
  lastCompletedAt: string | null;
  totalDurationSeconds: number;
  averageDurationSeconds: number | null;
  narrative: string;
  projects: TrainingRankingProjectResult[];
};

export type TrainingRankingResponse = {
  items: TrainingRankingItem[];
  pagination: TrainingPagination;
  projects: Array<{
    id: string;
    title: string;
  }>;
};

export type TrainingReviewRequest = {
  decision: 'APPROVED' | 'OVERRIDDEN';
  adminScore?: number | string;
  comment: string;
  unsupportedClaimsDecisions: TrainingUnsupportedClaimDecision[];
};
