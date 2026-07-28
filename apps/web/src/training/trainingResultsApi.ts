import type {
  TrainingAdminAttemptDetailResponse,
  TrainingAdminResultFiltersQuery,
  TrainingAdminResultsResponse,
  TrainingEmployeeAttemptFiltersQuery,
  TrainingEmployeeAttemptDetailResponse,
  TrainingEmployeeAttemptsResponse,
  TrainingEmployeeProjectsResponse,
  TrainingRankingResponse,
  TrainingRankingFiltersQuery,
  TrainingReviewRequest,
  TrainingTelegramAccountResponse,
} from '@platforma/shared';

import { apiDownload, apiRequest } from '../admin/api';

type QueryValue = string | number | boolean | undefined;

export function getTrainingProjects(accessToken: string) {
  return apiRequest<TrainingEmployeeProjectsResponse>(
    '/training/projects',
    accessToken,
  );
}

export function getTrainingTelegramAccount(accessToken: string) {
  return apiRequest<TrainingTelegramAccountResponse>(
    '/training/telegram/account',
    accessToken,
  );
}

export function createTrainingTelegramLink(
  accessToken: string,
  projectId?: string,
) {
  return apiRequest<{
    token: string;
    expiresAt: string;
    deepLink: string;
    projectId: string | null;
  }>('/training/telegram/link-tokens', accessToken, {
    method: 'POST',
    body: JSON.stringify(projectId ? { projectId } : {}),
  });
}

export function revokeTrainingTelegramAccount(accessToken: string) {
  return apiRequest<{ connected: boolean }>(
    '/training/telegram/account',
    accessToken,
    { method: 'DELETE' },
  );
}

export function createTrainingProjectStartLink(
  accessToken: string,
  projectId: string,
) {
  return apiRequest<{
    token: string;
    expiresAt: string;
    deepLink: string;
    projectId: string | null;
  }>(
    `/training/projects/${encodeURIComponent(projectId)}/start-link`,
    accessToken,
    { method: 'POST' },
  );
}

export function getTrainingAttempts(
  accessToken: string,
  query: TrainingEmployeeAttemptFiltersQuery = {},
) {
  return apiRequest<TrainingEmployeeAttemptsResponse>(
    withQuery('/training/attempts', query),
    accessToken,
  );
}

export function getTrainingAttempt(
  accessToken: string,
  attemptId: string,
) {
  return apiRequest<TrainingEmployeeAttemptDetailResponse>(
    `/training/attempts/${encodeURIComponent(attemptId)}`,
    accessToken,
  );
}

export function getTrainingAdminResults(
  accessToken: string,
  query:
    | TrainingAdminResultFiltersQuery
    | Record<string, QueryValue> = {},
) {
  return apiRequest<TrainingAdminResultsResponse>(
    withQuery('/training/admin/results', query),
    accessToken,
  );
}

export function getTrainingAdminAttempt(
  accessToken: string,
  attemptId: string,
) {
  return apiRequest<TrainingAdminAttemptDetailResponse>(
    `/training/admin/results/${encodeURIComponent(attemptId)}`,
    accessToken,
  );
}

export function reviewTrainingAttempt(
  accessToken: string,
  attemptId: string,
  request: TrainingReviewRequest,
  idempotencyKey: string,
) {
  return apiRequest(
    `/training/admin/results/${encodeURIComponent(attemptId)}/review`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(request),
    },
  );
}

export function reprocessTrainingAnswer(
  accessToken: string,
  answerId: string,
  kind: 'transcription' | 'evaluation',
  comment: string,
) {
  return apiRequest(
    `/training/admin/answers/${encodeURIComponent(answerId)}/reprocess-${kind}`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ comment }),
    },
  );
}

export function downloadTrainingAnswerAudio(
  accessToken: string,
  answerId: string,
) {
  return apiDownload(
    `/training/admin/answers/${encodeURIComponent(answerId)}/audio`,
    accessToken,
  );
}

export function getTrainingRanking(
  accessToken: string,
  query: TrainingRankingFiltersQuery = {},
) {
  return apiRequest<TrainingRankingResponse>(
    withQuery('/training/admin/ranking', query),
    accessToken,
  );
}

export function downloadTrainingRankingCsv(
  accessToken: string,
  query: Pick<TrainingRankingFiltersQuery, 'user' | 'projectId'> = {},
) {
  return apiDownload(
    withQuery('/training/admin/ranking/export.csv', query),
    accessToken,
  );
}

function withQuery(
  path: string,
  query: object,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}
