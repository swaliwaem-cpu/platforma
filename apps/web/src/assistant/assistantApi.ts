import type {
  AssistantAskInput,
  AssistantConfigResponse,
  AssistantJobResponse,
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
