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

export type TrainingRealEstateObject = {
  id: string;
  title: string;
  slug: string;
  status: string;
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
  file: {
    id: string;
    originalName: string | null;
    mimeType: string | null;
    sizeBytes: string | null;
  };
  createdAt: string;
  updatedAt: string;
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

export function listTrainingObjects(token: string) {
  return apiRequest<{ items: TrainingRealEstateObject[] }>(
    `${adminBase}/real-estate-objects?limit=100`,
    token,
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

  return apiRequest(path, token, {
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
    sourceLocator: unknown;
    isApproved: boolean;
    questionIds: string[];
  },
) {
  const path = fact.id
    ? `${adminBase}/versions/${versionId}/facts/${fact.id}`
    : `${adminBase}/versions/${versionId}/facts`;

  return apiRequest(path, token, {
    method: fact.id ? 'PATCH' : 'POST',
    body: JSON.stringify({
      code: fact.code,
      topicCode: fact.topicCode,
      statement: fact.statement,
      acceptedAliases: fact.acceptedAliases,
      importance: fact.importance,
      sourceDocumentId: fact.sourceDocumentId,
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

  return apiRequest(path, token, {
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
