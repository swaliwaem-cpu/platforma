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
