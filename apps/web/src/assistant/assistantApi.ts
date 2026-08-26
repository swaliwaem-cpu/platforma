import type {
  AssistantConfigResponse,
  AssistantConversationResponse,
  AssistantConversationsResponse,
  AssistantRunResponse,
  AssistantSendMessageInput,
  AssistantGeoResolution,
  AssistantGeoResolveInput,
  AssistantFeedbackInput,
  AssistantFeedbackResponse,
} from '@platforma/shared';

import { apiRequest } from '../admin/api';

export function getAssistantConfig(accessToken: string, signal?: AbortSignal) {
  return apiRequest<AssistantConfigResponse>('/assistant/config', accessToken, { signal });
}

export function listAssistantConversations(
  accessToken: string,
  cursor?: string | null,
  signal?: AbortSignal,
) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest<AssistantConversationsResponse>(`/assistant/conversations${query}`, accessToken, { signal });
}

export function createAssistantConversation(
  accessToken: string,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return apiRequest<AssistantConversationResponse>('/assistant/conversations', accessToken, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    signal,
  });
}

export function getAssistantConversation(
  accessToken: string,
  conversationId: string,
  signal?: AbortSignal,
) {
  return apiRequest<AssistantConversationResponse>(
    `/assistant/conversations/${encodeURIComponent(conversationId)}`,
    accessToken,
    { signal },
  );
}

export function sendAssistantMessage(input: {
  accessToken: string;
  conversationId: string;
  idempotencyKey: string;
  message: AssistantSendMessageInput;
  signal?: AbortSignal;
}) {
  return apiRequest<AssistantRunResponse>(
    `/assistant/conversations/${encodeURIComponent(input.conversationId)}/messages`,
    input.accessToken,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(input.message),
      signal: input.signal,
    },
  );
}

export function getAssistantRun(accessToken: string, runId: string, signal?: AbortSignal) {
  return apiRequest<AssistantRunResponse>(
    `/assistant/runs/${encodeURIComponent(runId)}`,
    accessToken,
    { signal },
  );
}

export function saveAssistantFeedback(
  accessToken: string,
  messageId: string,
  input: AssistantFeedbackInput,
  signal?: AbortSignal,
) {
  return apiRequest<AssistantFeedbackResponse>(
    `/assistant/messages/${encodeURIComponent(messageId)}/feedback`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
}

export function resolveAssistantGeo(
  accessToken: string,
  input: AssistantGeoResolveInput,
  signal?: AbortSignal,
) {
  return apiRequest<AssistantGeoResolution>('/assistant/geo/resolve', accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}
