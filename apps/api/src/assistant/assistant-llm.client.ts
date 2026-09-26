import { Injectable } from '@nestjs/common';

// Alibaba DashScope, OpenAI-compatible chat completions with function calling.

const defaultBaseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
// Picked by a side-by-side run on 2026-09-23: as accurate as Qwen, about twice as fast.
const defaultModel = 'deepseek-v4.1-flash';
const defaultTimeoutMs = 60_000;

export type AssistantLlmToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type AssistantLlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: AssistantLlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type AssistantLlmTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AssistantLlmRequest = {
  messages: AssistantLlmMessage[];
  tools: AssistantLlmTool[];
  /** Forces a call of this tool instead of letting the model choose. */
  requiredTool?: string;
  signal?: AbortSignal;
};

export type AssistantLlmResponse = {
  content: string | null;
  toolCalls: AssistantLlmToolCall[];
  /** cachedTokens is part of inputTokens; 0 when the provider does not report it. */
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number };
};

export interface AssistantLlm {
  isConfigured(): boolean;
  complete(request: AssistantLlmRequest): Promise<AssistantLlmResponse>;
}

export class AssistantLlmError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

@Injectable()
export class AssistantLlmClient implements AssistantLlm {
  isConfigured() {
    return Boolean(process.env.ALIBABA_API_KEY?.trim());
  }

  async complete(request: AssistantLlmRequest): Promise<AssistantLlmResponse> {
    const apiKey = process.env.ALIBABA_API_KEY?.trim();
    if (!apiKey) throw new AssistantLlmError('ASSISTANT_LLM_NOT_CONFIGURED');

    const baseUrl = (process.env.ASSISTANT_ALIBABA_BASE_URL?.trim() || defaultBaseUrl).replace(/\/+$/u, '');
    const timeoutMs = readPositiveInteger(process.env.ASSISTANT_LLM_TIMEOUT_MS, defaultTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    request.signal?.addEventListener('abort', abortFromParent, { once: true });

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(createRequestBody(request)),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as ChatCompletionBody | null;
      if (!response.ok || !body) {
        const reason = body?.error?.code ?? body?.code ?? '';
        throw new AssistantLlmError('ASSISTANT_LLM_REJECTED', `ASSISTANT_LLM_REJECTED: HTTP ${response.status} ${reason}`.trim());
      }
      const message = body.choices?.[0]?.message;
      return {
        content: typeof message?.content === 'string' && message.content.trim() ? message.content : null,
        toolCalls: (message?.tool_calls ?? []).flatMap((call) => call.function?.name
          ? [{ id: call.id ?? call.function.name, name: call.function.name, arguments: call.function.arguments ?? '{}' }]
          : []),
        usage: readUsage(body.usage),
      };
    } catch (error) {
      if (error instanceof AssistantLlmError) throw error;
      if (controller.signal.aborted) throw new AssistantLlmError('ASSISTANT_LLM_TIMEOUT');
      throw new AssistantLlmError(
        'ASSISTANT_LLM_UNAVAILABLE',
        `ASSISTANT_LLM_UNAVAILABLE: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abortFromParent);
    }
  }
}

type ChatCompletionBody = {
  code?: string;
  error?: { code?: string };
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: ChatCompletionUsage;
};

type ChatCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

export function readUsage(usage: ChatCompletionUsage | undefined): AssistantLlmResponse['usage'] {
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);
  return {
    inputTokens: count(usage?.prompt_tokens),
    cachedTokens: count(usage?.prompt_tokens_details?.cached_tokens),
    outputTokens: count(usage?.completion_tokens),
  };
}

export function resolveAssistantModel() {
  return process.env.ASSISTANT_MODEL?.trim() || defaultModel;
}

export function createRequestBody(request: AssistantLlmRequest) {
  return {
    model: resolveAssistantModel(),
    temperature: 0.2,
    // Hybrid Qwen models otherwise spend seconds on hidden reasoning before every tool call.
    enable_thinking: false,
    messages: request.messages.map((message) => {
      if (message.role === 'tool') {
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      }
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: message.content ?? '',
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        };
      }
      return message;
    }),
    tools: request.tools.map((tool) => ({ type: 'function', function: tool })),
    tool_choice: request.requiredTool
      ? { type: 'function', function: { name: request.requiredTool } }
      : 'auto',
    parallel_tool_calls: true,
  };
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
