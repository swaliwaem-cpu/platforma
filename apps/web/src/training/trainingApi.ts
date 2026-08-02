import type {
  CreateTrainingProjectRequest,
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
  TrainingTelegramAccountState,
  TrainingTelegramLinkResponse,
  UpdateTrainingProjectAvailabilityRequest,
  UpdateTrainingProjectRequest,
} from '@platforma/shared';

import { apiRequest } from '../admin/api';

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
