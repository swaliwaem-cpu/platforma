export type TrainingProjectStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type TrainingProjectAccessMode = 'ALL_PARTICIPANTS' | 'ASSIGNED_USERS';
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
export type TrainingAnswerSource = 'TEXT' | 'TELEGRAM';
export type TrainingAssignmentStatus = 'ASSIGNED' | 'REVOKED' | 'NEVER_ASSIGNED';
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
  version: 'training-v2-evaluation-v1' | 'training-v2-evaluation-v2';
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

export type TrainingUnsupportedClaimCategory =
  | 'HARMLESS_EXTRA'
  | 'MATERIAL_UNVERIFIED'
  | 'CONTRADICTORY'
  | 'UNSAFE_TO_SCORE';

export type TrainingStructuredEvaluation = {
  schema_version: 'training-v2-evaluation-v1' | 'training-v2-evaluation-v2';
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
  unsupported_claims: Array<{
    claim: string;
    evidence: string;
    category?: TrainingUnsupportedClaimCategory;
  }>;
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

export type TrainingFactSource = {
  sourceType: 'MANUAL' | 'MATERIAL';
  sourceRevisionId: string | null;
  sourceLabel: string;
  sourceLocator: string | null;
  sourceExcerpt: string | null;
  sourceMaterialType: 'PDF' | 'OFFICIAL_URL' | 'MANUAL_TEXT' | 'OBJECT_SNAPSHOT' | null;
  sourceUrl: string | null;
};

export type TrainingAdminFact = TrainingFactDraft & TrainingFactSource;

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
  accessMode: TrainingProjectAccessMode;
  activeAssignments: number;
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
  accessMode: TrainingProjectAccessMode;
  activeAssignments: number;
  isOpen: boolean;
  sortOrder: number;
  attemptLimit: number;
  timeLimitSeconds: number;
  passScore: number;
  allowRetakeAfterPass: boolean;
  contentSchemaVersion: number;
  mainQuestion: string;
  followUpQuestions: string[];
  facts: TrainingAdminFact[];
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
  accessMode?: TrainingProjectAccessMode;
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

export type UpdateTrainingProjectAccessModeRequest = {
  accessMode: TrainingProjectAccessMode;
};

export type TrainingProjectAssignmentFilter = 'all' | 'yes' | 'no';

export type TrainingProjectAssignmentUser = {
  userId: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'BLOCKED' | 'INVITED' | 'DEACTIVATED';
  canParticipate: boolean;
  isAssigned: boolean;
  assignedAt: string | null;
};

export type TrainingProjectAssignmentUsersResponse = {
  items: TrainingProjectAssignmentUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  activeAssignments: number;
};

export type BulkTrainingProjectAssignmentsRequest = {
  action: 'ASSIGN' | 'REVOKE';
  userIds: readonly string[];
};

export type BulkTrainingProjectAssignmentsResponse = {
  assigned: number;
  revoked: number;
  unchanged: number;
  activeAssignments: number;
};

export type TrainingMaterialType = 'PDF' | 'OFFICIAL_URL' | 'MANUAL_TEXT' | 'OBJECT_SNAPSHOT';
export type TrainingMaterialStatus = 'ACTIVE' | 'ARCHIVED';
export type TrainingMaterialRevisionStatus = 'READY' | 'FAILED';
export type TrainingMaterialSuggestionStatus = 'NOT_GENERATED' | 'READY' | 'FAILED';
export type TrainingMaterialOperationType = 'CREATE_PDF' | 'CREATE_OFFICIAL_URL' | 'IMPORT_OBJECT';
export type TrainingMaterialOperationStatus =
  | 'QUEUED'
  | 'STORING'
  | 'EXTRACTING'
  | 'GENERATING'
  | 'PERSISTING'
  | 'READY'
  | 'FAILED'
  | 'CANCELLED';

export type TrainingMaterialSegment = { locator: string; label: string; text: string };
export type TrainingMaterialDiff = {
  previousRevisionId: string | null;
  added: string[];
  removed: string[];
  unchangedCount: number;
  changed: boolean;
};

export type TrainingMaterialSuggestion = {
  id: string;
  targetQuestionId: string;
  statement: string;
  aliases: string[];
  isRequired: boolean;
  sourceLocator: string;
  sourceExcerpt: string;
};

export type TrainingMaterialRevision = {
  id: string;
  revisionNumber: number;
  previousRevisionId: string | null;
  status: TrainingMaterialRevisionStatus;
  requestedUrl: string | null;
  finalUrl: string | null;
  fetchedAt: string | null;
  extractedText: string;
  segments: TrainingMaterialSegment[];
  contentHash: string;
  extractionMetadata: Record<string, unknown>;
  diff: TrainingMaterialDiff;
  isChanged: boolean;
  suggestionStatus: TrainingMaterialSuggestionStatus;
  suggestions: TrainingMaterialSuggestion[] | null;
  suggestionModel: string | null;
  suggestionErrorCode: string | null;
  createdAt: string;
};

export type TrainingMaterial = {
  id: string;
  projectId: string;
  type: TrainingMaterialType;
  title: string;
  status: TrainingMaterialStatus;
  sourceUrl: string | null;
  officialConfirmedAt: string | null;
  latestRevision: TrainingMaterialRevision | null;
  createdAt: string;
  updatedAt: string;
};

export type TrainingMaterialsResponse = { items: TrainingMaterial[] };
export type TrainingMaterialDetail = TrainingMaterial & { revisions: TrainingMaterialRevision[] };

export type TrainingObjectOption = {
  id: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  developerName: string | null;
  pdfCount: number;
};

export type TrainingObjectOptionsResponse = {
  items: TrainingObjectOption[];
  selected: TrainingObjectOption | null;
};

export type ImportTrainingObjectRequest = {
  objectId: string;
  replaceExistingQuestions: boolean;
};

export type ImportTrainingObjectResponse = {
  object: TrainingObjectOption;
  objectSnapshotMaterialId: string;
  importedPdfCount: number;
  failedPdfTitles: string[];
  mainQuestion: string;
  followUpQuestions: string[];
  questionGenerationModel: string;
  questionGenerationSourceChars: number;
};

export type TrainingMaterialOperationItem = {
  id: string;
  itemKey: string;
  ordinal: number;
  title: string;
  status: TrainingMaterialOperationStatus;
  resultMaterialId: string | null;
  resultRevisionId: string | null;
  sourceHash: string | null;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TrainingMaterialOperation = {
  id: string;
  projectId: string;
  type: TrainingMaterialOperationType;
  status: TrainingMaterialOperationStatus;
  baseKnowledgeVersion: number;
  completedKnowledgeVersion: number | null;
  sourceHash: string | null;
  progress: {
    total: number;
    completed: number;
    failed: number;
  };
  attempts: number;
  errorCode: string | null;
  result: Record<string, unknown> | null;
  items: TrainingMaterialOperationItem[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TrainingMaterialOperationsResponse = {
  items: TrainingMaterialOperation[];
};

export type CreateTrainingManualMaterialRequest = { title: string; text: string };
export type CreateTrainingUrlMaterialRequest = {
  title: string;
  url: string;
  officialConfirmed: true;
  replaceExistingQuestions?: boolean;
};
export type CreateTrainingObjectSnapshotMaterialRequest = {
  title: string;
  fieldCodes: string[];
};
export type RefreshTrainingMaterialRequest = { text?: string; fieldCodes?: string[] };
export type ApplyTrainingMaterialSuggestionsRequest = {
  suggestions: Array<{
    suggestionId: string;
    targetQuestionId: string;
    statement: string;
    aliases: string[];
    isRequired: boolean;
    sourceLocator: string;
    sourceExcerpt: string;
  }>;
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
  newAttemptAccessRevoked: boolean;
  activeAttempt: { id: string; expiresAt: string } | null;
  bestConfirmedScore: number | null;
  bestConfirmedStatus: TrainingConfirmedStatus | null;
  lastConfirmedScore: number | null;
  lastConfirmedStatus: TrainingConfirmedStatus | null;
  lastConfirmedAt: string | null;
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

export type TrainingEmployeeSafeBreakdownItem = {
  sequence: number;
  type: TrainingQuestionType;
  score: number;
  maxScore: number;
  details: TrainingSafeBreakdown;
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
    safeBreakdown: TrainingEmployeeSafeBreakdownItem[];
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
  completionReason: TrainingAttemptCompletionReason;
  countsTowardAttemptLimit: boolean;
  finalScore: number | null;
  isPassed: boolean | null;
  safeBreakdown: TrainingEmployeeSafeBreakdownItem[];
  message: string | null;
  attemptRefunded: boolean;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
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

export type TrainingAdminResultSort =
  | 'STARTED_DESC'
  | 'STARTED_ASC'
  | 'COMPLETED_DESC'
  | 'COMPLETED_ASC'
  | 'SCORE_DESC'
  | 'SCORE_ASC'
  | 'DURATION_DESC'
  | 'DURATION_ASC';

export type TrainingAdminResultsQuery = {
  page: number;
  limit: number;
  search: string;
  userId: string;
  projectId: string;
  accessMode: TrainingProjectAccessMode | '';
  assignmentStatus: TrainingAssignmentStatus | '';
  startedFrom: string;
  startedTo: string;
  attemptStatus: TrainingAttemptStatus | '';
  reviewStatus: TrainingReviewStatus | '';
  passed: 'true' | 'false' | '';
  scoreMin: string;
  scoreMax: string;
  durationMin: string;
  durationMax: string;
  source: TrainingAnswerSource | '';
  sort: TrainingAdminResultSort;
};

export type TrainingAdminResultSummary = {
  id: string;
  user: { id: string; email: string; name: string | null };
  project: { id: string; title: string };
  currentAccess: {
    accessMode: TrainingProjectAccessMode;
    assignmentStatus: TrainingAssignmentStatus;
    hasCurrentAccess: boolean;
  };
  attemptNumber: number;
  status: TrainingAttemptStatus;
  completionReason: TrainingAttemptCompletionReason;
  reviewStatus: TrainingReviewStatus;
  reviewDecision: TrainingReviewDecision;
  countsTowardAttemptLimit: boolean;
  finalScore: number | null;
  isPassed: boolean | null;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number;
  answerCount: number;
  answerSources: TrainingAnswerSource[];
  hasPendingReview: boolean;
  hasTechnicalFailure: boolean;
};

export type TrainingAdminResultsResponse = {
  items: TrainingAdminResultSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type TrainingAdminRankingQuery = {
  page: number;
  limit: number;
  search: string;
  project: string;
  accessMode: TrainingProjectAccessMode | '';
  currentlyAssigned: 'true' | 'false' | '';
  currentlyEligible: 'true' | 'false' | '';
};

export type TrainingRankingCriterionSummary = {
  code: string;
  title: string;
  awardedPoints: number;
  maxPoints: number;
  percent: string;
};

export type TrainingRankingProjectResult = {
  attemptId: string;
  projectId: string;
  projectTitle: string;
  accessMode: TrainingProjectAccessMode;
  assignmentStatus: TrainingAssignmentStatus;
  currentlyEligible: boolean;
  finalScore: number;
  isPassed: boolean;
  completedAt: string;
  durationSeconds: number;
  factualErrorsCount: number;
  unsupportedClaimsCount: number;
  harmlessExtraClaimsCount: number;
  reviewRequiredClaimsCount: number;
};

export type TrainingAdminRankingRow = {
  user: { id: string; email: string; name: string | null };
  passedProjectsCount: number;
  completedProjectsCount: number;
  averageBestScore: string | null;
  attemptsUsed: number;
  lastCompletedAt: string | null;
  totalDurationSeconds: number;
  averageDurationSeconds: string | null;
  currentEligibleProjectsCount: number;
  currentCompletedEligibleProjectsCount: number;
  currentPassedEligibleProjectsCount: number;
  currentCoveragePercent: string | null;
  currentAccess: {
    allParticipantsProjectsCount: number;
    assignedProjectsCount: number;
    activeAssignmentsCount: number;
  };
  bestResults: TrainingRankingProjectResult[];
  summary: {
    text: string;
    strongestCriterion: TrainingRankingCriterionSummary | null;
    weakestCriterion: TrainingRankingCriterionSummary | null;
    factualErrorsCount: number;
    unsupportedClaimsCount: number;
    harmlessExtraClaimsCount: number;
    reviewRequiredClaimsCount: number;
  };
};

export type TrainingAdminRankingResponse = {
  items: TrainingAdminRankingRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
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
  snapshotVersion: number;
  durationSeconds: number;
  currentAccess: {
    projectStatus: TrainingProjectStatus;
    isOpen: boolean;
    accessMode: TrainingProjectAccessMode;
    assignmentStatus: TrainingAssignmentStatus;
    userStatus: 'ACTIVE' | 'BLOCKED' | 'INVITED' | 'DEACTIVATED';
    canParticipate: boolean;
    hasCurrentAccess: boolean;
  };
  calculatedScore: number | null;
  reviewStatus: TrainingReviewStatus;
  reviewDecision: TrainingReviewDecision;
  reviewedAt: string | null;
  reviewedBy: { id: string; email: string; name: string | null } | null;
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
    responseDurationSeconds: number | null;
    facts: Array<{
      id: string;
      statement: string;
      aliases: string[];
      required: boolean;
      position: number;
      sourceType?: 'MANUAL' | 'MATERIAL';
      sourceRevisionId?: string | null;
      sourceLabel?: string;
      sourceLocator?: string | null;
      sourceExcerpt?: string | null;
      sourceMaterialType?: 'PDF' | 'OFFICIAL_URL' | 'MANUAL_TEXT' | 'OBJECT_SNAPSHOT' | null;
      sourceUrl?: string | null;
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
      id: string;
      source: TrainingAnswerSource;
      processingStatus: 'COLLECTING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
      text: string | null;
      score: number | null;
      safeBreakdown: TrainingSafeBreakdown | null;
      submittedAt: string | null;
      transcriptionModel: string | null;
      evaluationModel: string | null;
      transcriptionRequestId: string | null;
      evaluationRequestId: string | null;
      evaluation: TrainingStructuredEvaluation | null;
      objectiveMetrics: TrainingObjectiveMetrics | null;
      technicalErrorCode: string | null;
      audioAvailable: boolean;
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
