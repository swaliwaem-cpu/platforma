import { apiDownload, apiRequest } from '../admin/api';

export type TrainingProjectStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED';
export type TrainingVersionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
export type TrainingQuestionType = 'MAIN' | 'FOLLOW_UP';
export type TrainingDocumentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'READY'
  | 'NEEDS_MANUAL_TEXT'
  | 'FAILED';

export type TrainingAudienceMode = 'ALL_ELIGIBLE' | 'ASSIGNED_ONLY';

export type TrainingRealEstateObject = {
  id: string;
  title: string;
  slug: string;
  status: string;
  pdfCount?: number;
  eligiblePdfCount?: number;
};

export type TrainingQuestion = {
  id: string;
  type: TrainingQuestionType;
  text: string;
  position: number;
  isActive: boolean;
  maxScore: number;
  topicCodesJson: unknown;
};

export type TrainingFact = {
  id: string;
  code: string;
  topicCode: string;
  statement: string;
  acceptedAliasesJson: unknown;
  importance: number;
  sourceDocumentId: string | null;
  sourceOfficialUrlId: string | null;
  sourceLocatorJson: unknown;
  isApproved: boolean;
  questionLinks: Array<{ questionId: string }>;
};

export type TrainingCriterion = {
  id: string;
  questionType: TrainingQuestionType;
  code: string;
  title: string;
  maxPoints: string | number;
  description: string | null;
  anchorsJson: unknown;
  sortOrder: number;
};

export type TrainingCriterionAnchor = {
  id: string;
  points: number;
  description: string;
};

export type TrainingVersion = {
  id: string;
  projectId: string;
  versionNumber: number;
  status: TrainingVersionStatus;
  passScore: number;
  attemptLimit: number;
  cooldownMinutes: number;
  totalTimeLimitSeconds: number;
  finishGraceSeconds: number;
  warningSecondsJson: unknown;
  allowRetakeAfterPass: boolean;
  mainMaxScore: number;
  followUpMaxScore: number;
  scoringConfigJson: unknown;
  promptVersion: string;
  schemaVersion: string;
  publishedAt: string | null;
  questions: TrainingQuestion[];
  facts: TrainingFact[];
  criteria: TrainingCriterion[];
};

export type TrainingProject = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: TrainingProjectStatus;
  sortOrder: number;
  availableFrom: string | null;
  deadlineAt: string | null;
  activeVersionId: string | null;
  realEstateObjectId: string | null;
  realEstateObject: TrainingRealEstateObject | null;
  audienceMode: TrainingAudienceMode;
  audienceRevision: number;
  versions: TrainingVersion[];
  activeVersion?: Pick<
    TrainingVersion,
    | 'id'
    | 'versionNumber'
    | 'status'
    | 'passScore'
    | 'attemptLimit'
    | 'cooldownMinutes'
    | 'totalTimeLimitSeconds'
    | 'allowRetakeAfterPass'
    | 'publishedAt'
  > | null;
  _count?: { attempts: number };
};

export type TrainingDocument = {
  id: string;
  projectVersionId: string;
  documentType: 'PDF' | 'DOCX' | 'PPTX' | 'XLSX';
  checksum: string;
  extractionStatus: TrainingDocumentStatus;
  errorMessage: string | null;
  extractedCharacterCount: number;
  textPreview: string;
  linkedFactCount: number;
  originKind: 'UPLOAD' | 'LINKED_OBJECT_PDF';
  originMetadata: {
    objectId?: string;
    objectTitle?: string;
    objectSlug?: string;
    objectFileId?: string;
    objectFileType?: TrainingLinkedObjectPdfType;
    objectFileTitle?: string | null;
  } | null;
  file: {
    id: string;
    originalName: string | null;
    mimeType: string | null;
    sizeBytes: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type TrainingWizardStep =
  | 'main'
  | 'sources'
  | 'suggestions'
  | 'assignments'
  | 'questions'
  | 'criteria'
  | 'review';

export type TrainingLinkedObjectPdfType =
  | 'PRESENTATION'
  | 'DOCUMENT'
  | 'FLOOR_PLAN'
  | 'OTHER';

export type TrainingLinkedObjectPdf = {
  objectFileId: string;
  type: TrainingLinkedObjectPdfType;
  title: string | null;
  sortOrder: number;
  recommendedByDefault: boolean;
  eligible: boolean;
  eligibilityError: string | null;
  alreadyAttached: boolean;
  sourceDocumentId: string | null;
  file: {
    id: string;
    originalName: string | null;
    mimeType: string | null;
    sizeBytes: string | null;
    createdAt: string;
  };
};

export type TrainingAssignmentCandidate = {
  id: string;
  name: string | null;
  email: string;
  status: string;
  telegramConnected: boolean;
  eligible?: boolean;
};

export type TrainingProjectAssignment = {
  userId: string;
  name: string | null;
  email: string;
  status: string;
  eligible: boolean;
  telegramConnected: boolean;
  assignedAt: string;
};

export type TrainingAssignmentSummary = {
  audienceMode: TrainingAudienceMode;
  audienceRevision: number;
  items: TrainingProjectAssignment[];
  total: number;
  eligibleTotal: number;
};

export type TrainingReadiness = {
  readyToPublish: boolean;
  facts: {
    approved: number;
    total: number;
    pendingSuggestions: number;
    ready: boolean;
  };
  questions: {
    active: number;
    required: 11;
    mainReady: boolean;
    followUpsReady: boolean;
    positionsReady: boolean;
    ready: boolean;
  };
  criteria: {
    mainPoints: number;
    mainRequired: 55;
    followUpPoints: number;
    followUpRequired: 15;
    ready: boolean;
  };
  issues: Array<{
    code: string;
    step: TrainingWizardStep;
    entityId?: string;
    message: string;
  }>;
};

export type TrainingOfficialUrlSource = {
  id: string;
  projectVersionId: string;
  inputUrl: string;
  normalizedUrl: string;
  confirmedOfficialHost: string;
  extractionStatus: TrainingDocumentStatus;
  errorMessage: string | null;
  extractedCharacterCount: number;
  textPreview: string;
  checksum: string | null;
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TrainingFactSuggestionStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'STALE';

export type TrainingFactSuggestion = {
  id: string;
  runId: string;
  status: TrainingFactSuggestionStatus;
  suggestedCode: string;
  topicCode: string;
  statement: string;
  acceptedAliases: string[];
  importance: number;
  sourceKind: 'DOCUMENT' | 'OFFICIAL_URL';
  sourceId: string;
  sourceLocator: unknown;
  sourceQuote: string | null;
  acceptedFactId: string | null;
  decisionReason: string | null;
};

export type TrainingFactSuggestionRun = {
  id: string;
  status:
    | 'PENDING'
    | 'RUNNING'
    | 'READY'
    | 'PARTIAL'
    | 'FAILED'
    | 'AMBIGUOUS'
    | 'DISMISSED';
  counts: {
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
    stale: number;
  };
  errorMessage?: string | null;
  createdAt: string;
  updatedAt?: string;
};

export type ProjectDraftInput = {
  title: string;
  slug: string;
  description: string | null;
  realEstateObjectId: string | null;
  sortOrder: number;
  availableFrom: string | null;
  deadlineAt: string | null;
  draft: VersionSettingsInput;
};

export type VersionSettingsInput = {
  passScore: number;
  attemptLimit: number;
  cooldownMinutes: number;
  totalTimeLimitSeconds: number;
  finishGraceSeconds: number;
  warningSeconds: number[];
  allowRetakeAfterPass: boolean;
};

const adminBase = '/training/admin';

export function listTrainingProjects(
  token: string,
  params: { search?: string; status?: string; page?: number; limit?: number },
) {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 50));

  return apiRequest<{
    items: TrainingProject[];
    total: number;
    page: number;
    totalPages: number;
  }>(`${adminBase}/projects?${query.toString()}`, token);
}

export function getTrainingProject(token: string, projectId: string) {
  return apiRequest<{ project: TrainingProject }>(
    `${adminBase}/projects/${encodeURIComponent(projectId)}`,
    token,
  );
}

export function createTrainingProject(token: string, input: ProjectDraftInput) {
  return apiRequest<{ project: TrainingProject }>(`${adminBase}/projects`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateTrainingProject(
  token: string,
  projectId: string,
  input: Omit<ProjectDraftInput, 'draft'>,
) {
  return apiRequest<{ project: TrainingProject }>(
    `${adminBase}/projects/${encodeURIComponent(projectId)}`,
    token,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function createTrainingDraftVersion(token: string, projectId: string) {
  return apiRequest<{ version: TrainingVersion }>(
    `${adminBase}/projects/${encodeURIComponent(projectId)}/draft-version`,
    token,
    { method: 'POST' },
  );
}

export function updateTrainingVersion(
  token: string,
  versionId: string,
  input: VersionSettingsInput,
) {
  return apiRequest<{ version: TrainingVersion }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}`,
    token,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function publishTrainingVersion(token: string, versionId: string) {
  return apiRequest<{ version: TrainingVersion }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/publish`,
    token,
    { method: 'POST' },
  );
}

export function changeTrainingProjectStatus(
  token: string,
  projectId: string,
  action: 'open' | 'close' | 'archive',
) {
  return apiRequest<{ project: TrainingProject }>(
    `${adminBase}/projects/${encodeURIComponent(projectId)}/${action}`,
    token,
    { method: 'POST' },
  );
}

export function listTrainingObjects(
  token: string,
  params: {
    search?: string;
    hasPdf?: boolean;
    page?: number;
    limit?: number;
  } = {},
) {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.hasPdf !== undefined) query.set('hasPdf', String(params.hasPdf));
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 20));

  return apiRequest<{
    items: TrainingRealEstateObject[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }>(
    `${adminBase}/real-estate-objects?${query.toString()}`,
    token,
  );
}

export function listTrainingLinkedObjectPdfs(
  token: string,
  versionId: string,
) {
  return apiRequest<{
    realEstateObject: TrainingRealEstateObject | null;
    items: TrainingLinkedObjectPdf[];
  }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/linked-object-pdfs`,
    token,
  );
}

export function attachTrainingLinkedObjectPdfs(
  token: string,
  versionId: string,
  objectFileIds: string[],
) {
  return apiRequest<{
    items: Array<{
      objectFileId: string;
      alreadyAttached: boolean;
      document: TrainingDocument;
    }>;
    createdCount: number;
  }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/documents/from-linked-object`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ objectFileIds }),
    },
  );
}

export function listTrainingAssignees(
  token: string,
  params: { search?: string; page?: number; limit?: number } = {},
) {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 20));

  return apiRequest<{
    items: TrainingAssignmentCandidate[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }>(`${adminBase}/assignees?${query.toString()}`, token);
}

export function getTrainingProjectAssignments(
  token: string,
  projectId: string,
) {
  return apiRequest<TrainingAssignmentSummary>(
    `${adminBase}/projects/${encodeURIComponent(projectId)}/assignments`,
    token,
  );
}

export function updateTrainingProjectAudience(
  token: string,
  projectId: string,
  input: {
    audienceMode: TrainingAudienceMode;
    expectedRevision: number;
  },
) {
  return apiRequest<TrainingAssignmentSummary>(
    `${adminBase}/projects/${encodeURIComponent(projectId)}/audience`,
    token,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function replaceTrainingProjectAssignments(
  token: string,
  projectId: string,
  input: { userIds: string[]; expectedRevision: number },
) {
  return apiRequest<TrainingAssignmentSummary>(
    `${adminBase}/projects/${encodeURIComponent(projectId)}/assignments`,
    token,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

export function saveTrainingQuestion(
  token: string,
  versionId: string,
  question: Partial<TrainingQuestion> & {
    type: TrainingQuestionType;
    text: string;
    position: number;
    isActive: boolean;
    maxScore: number;
    topicCodes: string[];
  },
) {
  const path = question.id
    ? `${adminBase}/versions/${versionId}/questions/${question.id}`
    : `${adminBase}/versions/${versionId}/questions`;

  return apiRequest<{ question: TrainingQuestion }>(path, token, {
    method: question.id ? 'PATCH' : 'POST',
    body: JSON.stringify({
      type: question.type,
      text: question.text,
      position: question.position,
      isActive: question.isActive,
      maxScore: question.maxScore,
      topicCodes: question.topicCodes,
    }),
  });
}

export function deleteTrainingQuestion(
  token: string,
  versionId: string,
  questionId: string,
) {
  return apiRequest(
    `${adminBase}/versions/${versionId}/questions/${questionId}`,
    token,
    { method: 'DELETE' },
  );
}

export function saveTrainingFact(
  token: string,
  versionId: string,
  fact: {
    id?: string;
    code: string;
    topicCode: string;
    statement: string;
    acceptedAliases: string[];
    importance: number;
    sourceDocumentId: string | null;
    sourceOfficialUrlId: string | null;
    sourceLocator: unknown;
    isApproved: boolean;
    questionIds: string[];
  },
) {
  const path = fact.id
    ? `${adminBase}/versions/${versionId}/facts/${fact.id}`
    : `${adminBase}/versions/${versionId}/facts`;

  return apiRequest<{ fact: TrainingFact }>(path, token, {
    method: fact.id ? 'PATCH' : 'POST',
    body: JSON.stringify({
      code: fact.code,
      topicCode: fact.topicCode,
      statement: fact.statement,
      acceptedAliases: fact.acceptedAliases,
      importance: fact.importance,
      sourceDocumentId: fact.sourceDocumentId,
      sourceOfficialUrlId: fact.sourceOfficialUrlId,
      sourceLocator: fact.sourceLocator,
      isApproved: fact.isApproved,
      questionIds: fact.questionIds,
    }),
  });
}

export function deleteTrainingFact(
  token: string,
  versionId: string,
  factId: string,
) {
  return apiRequest(`${adminBase}/versions/${versionId}/facts/${factId}`, token, {
    method: 'DELETE',
  });
}

export function saveTrainingCriterion(
  token: string,
  versionId: string,
  criterion: {
    id?: string;
    questionType: TrainingQuestionType;
    code: string;
    title: string;
    maxPoints: number;
    description: string | null;
    anchors: TrainingCriterionAnchor[];
    sortOrder: number;
  },
) {
  const path = criterion.id
    ? `${adminBase}/versions/${versionId}/criteria/${criterion.id}`
    : `${adminBase}/versions/${versionId}/criteria`;

  return apiRequest<{ criterion: TrainingCriterion }>(path, token, {
    method: criterion.id ? 'PATCH' : 'POST',
    body: JSON.stringify({
      questionType: criterion.questionType,
      code: criterion.code,
      title: criterion.title,
      maxPoints: criterion.maxPoints,
      description: criterion.description,
      anchors: criterion.anchors,
      sortOrder: criterion.sortOrder,
    }),
  });
}

export function deleteTrainingCriterion(
  token: string,
  versionId: string,
  criterionId: string,
) {
  return apiRequest(
    `${adminBase}/versions/${versionId}/criteria/${criterionId}`,
    token,
    { method: 'DELETE' },
  );
}

export function listTrainingDocuments(token: string, versionId: string) {
  return apiRequest<{ items: TrainingDocument[] }>(
    `${adminBase}/versions/${versionId}/documents`,
    token,
  );
}

export function uploadTrainingDocument(
  token: string,
  versionId: string,
  file: File,
) {
  const body = new FormData();
  body.append('file', file);

  return apiRequest<{ document: TrainingDocument }>(
    `${adminBase}/versions/${versionId}/documents`,
    token,
    { method: 'POST', body },
  );
}

export function getTrainingDocumentText(
  token: string,
  versionId: string,
  documentId: string,
) {
  return apiRequest<{
    document: TrainingDocument;
    extractedText: string;
    extractionMetadata: unknown;
    draftOnly: true;
    scoringEligible: false;
  }>(
    `${adminBase}/versions/${versionId}/documents/${documentId}/text`,
    token,
  );
}

export function updateTrainingDocumentText(
  token: string,
  versionId: string,
  documentId: string,
  extractedText: string,
) {
  return apiRequest<{ document: TrainingDocument }>(
    `${adminBase}/versions/${versionId}/documents/${documentId}`,
    token,
    { method: 'PATCH', body: JSON.stringify({ extractedText }) },
  );
}

export function retryTrainingDocument(
  token: string,
  versionId: string,
  documentId: string,
) {
  return apiRequest<{ document: TrainingDocument }>(
    `${adminBase}/versions/${versionId}/documents/${documentId}/retry`,
    token,
    { method: 'POST' },
  );
}

export function deleteTrainingDocument(
  token: string,
  versionId: string,
  documentId: string,
) {
  return apiRequest(
    `${adminBase}/versions/${versionId}/documents/${documentId}`,
    token,
    { method: 'DELETE' },
  );
}

export function downloadTrainingDocument(
  token: string,
  versionId: string,
  documentId: string,
) {
  return apiDownload(
    `${adminBase}/versions/${versionId}/documents/${documentId}/content`,
    token,
  );
}

export function getTrainingReadiness(token: string, versionId: string) {
  return apiRequest<{ readiness: TrainingReadiness }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/readiness`,
    token,
  );
}

export function listTrainingOfficialUrlSources(token: string, versionId: string) {
  return apiRequest<{ items: TrainingOfficialUrlSource[] }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/official-url-sources`,
    token,
  );
}

export function createTrainingOfficialUrlSource(
  token: string,
  versionId: string,
  input: { url: string; confirmedOfficialHost: string },
) {
  return apiRequest<{ source: TrainingOfficialUrlSource }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/official-url-sources`,
    token,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function getTrainingOfficialUrlSourceText(
  token: string,
  versionId: string,
  sourceId: string,
) {
  return apiRequest<{
    source: TrainingOfficialUrlSource;
    extractedText: string;
    extractionMetadata: unknown;
    draftOnly: true;
    scoringEligible: false;
  }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/official-url-sources/${encodeURIComponent(sourceId)}/text`,
    token,
  );
}

export function retryTrainingOfficialUrlSource(
  token: string,
  versionId: string,
  sourceId: string,
) {
  return apiRequest<{ source: TrainingOfficialUrlSource }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/official-url-sources/${encodeURIComponent(sourceId)}/retry`,
    token,
    { method: 'POST' },
  );
}

export function deleteTrainingOfficialUrlSource(
  token: string,
  versionId: string,
  sourceId: string,
) {
  return apiRequest(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/official-url-sources/${encodeURIComponent(sourceId)}`,
    token,
    { method: 'DELETE' },
  );
}

export function createTrainingFactSuggestionRun(
  token: string,
  versionId: string,
  sourceIds: Array<{ kind: 'DOCUMENT' | 'OFFICIAL_URL'; id: string }>,
  idempotencyKey = createTrainingIdempotencyKey(),
) {
  return apiRequest<{ run: TrainingFactSuggestionRun }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/fact-suggestion-runs`,
    token,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ sourceIds }),
    },
  );
}

export function getLatestTrainingFactSuggestionRun(
  token: string,
  versionId: string,
) {
  return apiRequest<{ run: TrainingFactSuggestionRun | null }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/fact-suggestion-runs/latest`,
    token,
  );
}

export function listTrainingFactSuggestions(token: string, versionId: string) {
  return apiRequest<{ items: TrainingFactSuggestion[] }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/fact-suggestions`,
    token,
  );
}

export function acceptTrainingFactSuggestion(
  token: string,
  versionId: string,
  suggestionId: string,
  input: {
    code: string;
    topicCode: string;
    statement: string;
    acceptedAliases: string[];
    importance: number;
    questionIds: string[];
  },
) {
  return apiRequest<{ suggestion: TrainingFactSuggestion; fact: TrainingFact }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/fact-suggestions/${encodeURIComponent(suggestionId)}/accept`,
    token,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function rejectTrainingFactSuggestion(
  token: string,
  versionId: string,
  suggestionId: string,
  reason: string,
) {
  return apiRequest<{ suggestion: TrainingFactSuggestion }>(
    `${adminBase}/versions/${encodeURIComponent(versionId)}/fact-suggestions/${encodeURIComponent(suggestionId)}/reject`,
    token,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

function createTrainingIdempotencyKey() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `training-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
