import type {
  AssistantAdminTurnResponse,
  AssistantAdminTurnsResponse,
  AssistantAskInput,
  AssistantConfigResponse,
  AssistantJobResponse,
  AssistantTurnFeedbackInput,
  AssistantUsageResponse,
} from '@platforma/shared';

import { apiRequest } from '../admin/api';

export function getAssistantConfig(accessToken: string, signal?: AbortSignal) {
  return apiRequest<AssistantConfigResponse>('/assistant/config', accessToken, { signal });
}

export function startAssistantJob(accessToken: string, input: AssistantAskInput, signal?: AbortSignal) {
  return apiRequest<AssistantJobResponse>('/assistant/jobs', accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export function getAssistantJob(accessToken: string, jobId: string, signal?: AbortSignal) {
  return apiRequest<AssistantJobResponse>(`/assistant/jobs/${encodeURIComponent(jobId)}`, accessToken, { signal });
}

export function rateAssistantTurn(accessToken: string, turnId: string, input: AssistantTurnFeedbackInput) {
  return apiRequest<null>(`/assistant/turns/${encodeURIComponent(turnId)}/feedback`, accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getAssistantAdminTurns(
  accessToken: string,
  filters: { rating?: 'UP' | 'DOWN'; cursor?: string | null },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  if (filters.rating) params.set('rating', filters.rating);
  if (filters.cursor) params.set('cursor', filters.cursor);
  const query = params.toString();
  return apiRequest<AssistantAdminTurnsResponse>(`/assistant/admin/turns${query ? `?${query}` : ''}`, accessToken, { signal });
}

export function getAssistantAdminTurn(accessToken: string, turnId: string, signal?: AbortSignal) {
  return apiRequest<AssistantAdminTurnResponse>(`/assistant/admin/turns/${encodeURIComponent(turnId)}`, accessToken, { signal });
}

export function getAssistantUsage(accessToken: string, days: number, signal?: AbortSignal) {
  return apiRequest<AssistantUsageResponse>(`/assistant/admin/usage?days=${days}`, accessToken, { signal });
}
