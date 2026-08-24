import type {
  AssistantConfigResponse,
  AssistantConversationResponse,
  AssistantConversationsResponse,
  AssistantRunResponse,
  AssistantSendMessageInput,
} from '@platforma/shared';

import { apiRequest } from '../admin/api';

export function getAssistantConfig(accessToken: string, signal?: AbortSignal) {
  return apiRequest<AssistantConfigResponse>('/assistant/config', accessToken, { signal });
}

export function listAssistantConversations(accessToken: string, signal?: AbortSignal) {
  return apiRequest<AssistantConversationsResponse>('/assistant/conversations', accessToken, { signal });
}

export function createAssistantConversation(accessToken: string, signal?: AbortSignal) {
  return apiRequest<AssistantConversationResponse>('/assistant/conversations', accessToken, {
    method: 'POST',
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
