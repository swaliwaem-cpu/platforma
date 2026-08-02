import type {
  CreateTrainingProjectRequest,
  ImportTrainingObjectRequest,
  ImportTrainingObjectResponse,
  ApplyTrainingMaterialSuggestionsRequest,
  CreateTrainingManualMaterialRequest,
  CreateTrainingObjectSnapshotMaterialRequest,
  CreateTrainingUrlMaterialRequest,
  ReviewTrainingAttemptRequest,
  ReviewTrainingAttemptResponse,
  StartTrainingAttemptRequest,
  SubmitTrainingAnswerRequest,
  TrainingAdminAttempt,
  TrainingAdminAttemptsResponse,
  TrainingAdminProject,
  TrainingAdminProjectsResponse,
  TrainingEmployeeAttempt,
  TrainingEmployeeAttemptsResponse,
  TrainingEmployeeProjectsResponse,
  TrainingMaterialDetail,
  TrainingMaterialsResponse,
  TrainingObjectOptionsResponse,
  TrainingTelegramAccountState,
  TrainingTelegramLinkResponse,
  UpdateTrainingProjectAvailabilityRequest,
  UpdateTrainingProjectRequest,
} from '@platforma/shared';

import { apiRequest, apiResponse } from '../admin/api';

export function getTrainingProjects(accessToken: string, signal?: AbortSignal) {
  return apiRequest<TrainingEmployeeProjectsResponse>('/training/projects', accessToken, {
    signal,
  });
}

export function getTrainingAttempts(accessToken: string, signal?: AbortSignal) {
  return apiRequest<TrainingEmployeeAttemptsResponse>('/training/attempts', accessToken, {
    signal,
  });
}

export function getTrainingTelegramAccount(accessToken: string, signal?: AbortSignal) {
  return apiRequest<TrainingTelegramAccountState>('/training/telegram/account', accessToken, {
    signal,
  });
}

export function createTrainingTelegramLink(accessToken: string, projectId: string) {
  return apiRequest<TrainingTelegramLinkResponse>(
    `/training/projects/${encodeURIComponent(projectId)}/telegram-link`,
    accessToken,
    { method: 'POST' },
  );
}

export function startTrainingAttempt(
  accessToken: string,
  projectId: string,
  idempotencyKey: string,
  input: StartTrainingAttemptRequest,
) {
  return apiRequest<TrainingEmployeeAttempt>(
    `/training/projects/${encodeURIComponent(projectId)}/attempts`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    },
  );
}

export function getTrainingAttempt(
  accessToken: string,
  attemptId: string,
  signal?: AbortSignal,
) {
  return apiRequest<TrainingEmployeeAttempt>(
    `/training/attempts/${encodeURIComponent(attemptId)}`,
    accessToken,
    { signal },
  );
}

export function submitTrainingAnswer(
  accessToken: string,
  attemptId: string,
  input: SubmitTrainingAnswerRequest,
) {
  return apiRequest<TrainingEmployeeAttempt>(
    `/training/attempts/${encodeURIComponent(attemptId)}/answers`,
    accessToken,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function getTrainingAdminProjects(accessToken: string, signal?: AbortSignal) {
  return apiRequest<TrainingAdminProjectsResponse>('/training/admin/projects', accessToken, {
    signal,
  });
}

export function createTrainingAdminProject(
  accessToken: string,
  input: CreateTrainingProjectRequest,
) {
  return apiRequest<TrainingAdminProject>('/training/admin/projects', accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getTrainingAdminProject(
  accessToken: string,
  projectId: string,
  signal?: AbortSignal,
) {
  return apiRequest<TrainingAdminProject>(
    `/training/admin/projects/${encodeURIComponent(projectId)}`,
    accessToken,
    { signal },
  );
}

export function updateTrainingAdminProject(
  accessToken: string,
  projectId: string,
  input: UpdateTrainingProjectRequest | UpdateTrainingProjectAvailabilityRequest,
) {
  return apiRequest<TrainingAdminProject>(
    `/training/admin/projects/${encodeURIComponent(projectId)}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function publishTrainingAdminProject(accessToken: string, projectId: string) {
  return apiRequest<TrainingAdminProject>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/publish`,
    accessToken,
    { method: 'POST' },
  );
}

export function getTrainingMaterials(accessToken: string, projectId: string, signal?: AbortSignal) {
  return apiRequest<TrainingMaterialsResponse>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/materials`,
    accessToken,
    { signal },
  );
}

export function getTrainingObjectOptions(
  accessToken: string,
  projectId: string,
  search: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (search.trim()) query.set('search', search.trim());
  const suffix = query.size ? `?${query.toString()}` : '';
  return apiRequest<TrainingObjectOptionsResponse>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/object-options${suffix}`,
    accessToken,
    { signal },
  );
}

export function importTrainingObjectContent(
  accessToken: string,
  projectId: string,
  input: ImportTrainingObjectRequest,
) {
  return apiRequest<ImportTrainingObjectResponse>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/import-object`,
    accessToken,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function getTrainingMaterial(accessToken: string, materialId: string, signal?: AbortSignal) {
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/materials/${encodeURIComponent(materialId)}`,
    accessToken,
    { signal },
  );
}

export function createTrainingManualMaterial(
  accessToken: string,
  projectId: string,
  input: CreateTrainingManualMaterialRequest,
) {
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/materials`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ type: 'MANUAL_TEXT', ...input }) },
  );
}

export function createTrainingUrlMaterial(
  accessToken: string,
  projectId: string,
  input: CreateTrainingUrlMaterialRequest,
) {
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/materials`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ type: 'OFFICIAL_URL', ...input }) },
  );
}

export function createTrainingObjectMaterial(
  accessToken: string,
  projectId: string,
  input: CreateTrainingObjectSnapshotMaterialRequest,
) {
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/materials`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ type: 'OBJECT_SNAPSHOT', ...input }) },
  );
}

export function createTrainingPdfMaterial(
  accessToken: string,
  projectId: string,
  title: string,
  file: File,
) {
  const form = new FormData();
  form.set('title', title);
  form.set('file', file);
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/projects/${encodeURIComponent(projectId)}/materials/pdf`,
    accessToken,
    { method: 'POST', body: form },
  );
}

export function refreshTrainingMaterial(
  accessToken: string,
  materialId: string,
  input: { text?: string; fieldCodes?: string[] },
) {
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/materials/${encodeURIComponent(materialId)}/revisions`,
    accessToken,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function refreshTrainingPdfMaterial(accessToken: string, materialId: string, file: File) {
  const form = new FormData();
  form.set('file', file);
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/materials/${encodeURIComponent(materialId)}/revisions`,
    accessToken,
    { method: 'POST', body: form },
  );
}

export function generateTrainingMaterialSuggestions(accessToken: string, revisionId: string) {
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/material-revisions/${encodeURIComponent(revisionId)}/suggestions`,
    accessToken,
    { method: 'POST' },
  );
}

export function applyTrainingMaterialSuggestions(
  accessToken: string,
  revisionId: string,
  input: ApplyTrainingMaterialSuggestionsRequest,
) {
  return apiRequest<{ createdFactIds: string[]; duplicates: Array<{ suggestionId: string; reason: string }> }>(
    `/training/admin/material-revisions/${encodeURIComponent(revisionId)}/apply-suggestions`,
    accessToken,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function archiveTrainingMaterial(accessToken: string, materialId: string) {
  return apiRequest<TrainingMaterialDetail>(
    `/training/admin/materials/${encodeURIComponent(materialId)}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify({ status: 'ARCHIVED' }) },
  );
}

export async function downloadTrainingMaterialPdf(
  accessToken: string,
  materialId: string,
  title: string,
) {
  const response = await apiResponse(
    `/training/admin/materials/${encodeURIComponent(materialId)}/pdf`,
    accessToken,
  );
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${title.replace(/[^a-zа-яё0-9._-]+/giu, '_') || 'training-material'}.pdf`;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

export function getTrainingAdminAttempts(accessToken: string, signal?: AbortSignal) {
  return apiRequest<TrainingAdminAttemptsResponse>('/training/admin/attempts', accessToken, {
    signal,
  });
}

export function getTrainingAdminAttempt(
  accessToken: string,
  attemptId: string,
  signal?: AbortSignal,
) {
  return apiRequest<TrainingAdminAttempt>(
    `/training/admin/attempts/${encodeURIComponent(attemptId)}`,
    accessToken,
    { signal },
  );
}

export function reviewTrainingAdminAttempt(
  accessToken: string,
  attemptId: string,
  input: ReviewTrainingAttemptRequest,
) {
  return apiRequest<ReviewTrainingAttemptResponse>(
    `/training/admin/attempts/${encodeURIComponent(attemptId)}/review`,
    accessToken,
    { method: 'POST', body: JSON.stringify(input) },
  );
}
