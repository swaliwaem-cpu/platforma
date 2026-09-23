// Training talks to Alibaba DashScope (OpenAI-compatible chat completions) with the
// same ALIBABA_API_KEY and base URL as the assistant. DeepSeek does the text work,
// Qwen ASR does speech recognition.
export const DEFAULT_TRAINING_ALIBABA_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_TRAINING_TRANSCRIPTION_MODEL = 'qwen3-asr-flash';
export const DEFAULT_TRAINING_PRIMARY_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_TRAINING_FALLBACK_MODEL = 'deepseek-v4-pro';

export type TrainingAiMode = 'fake' | 'alibaba';

export type TrainingOpenAIRequestPolicy = {
  timeoutMs: number;
  maxRetries: number;
};

export type TrainingOpenAIResponse<T> = {
  value: T;
  requestId: string | null;
  latencyMs: number;
  attempts: number;
};

export type TrainingOpenAIResponseObservation = {
  response: Response;
  requestId: string | null;
  attempt: number;
  durationMs: number;
};

export type TrainingOpenAIAttemptOutcome =
  | 'accepted'
  | 'local_validation_failed'
  | 'transport_error'
  | 'provider_error';

export type TrainingOpenAIAttemptObservation = {
  response: Response | null;
  clientRequestId: string | null;
  requestId: string | null;
  attempt: number;
  durationMs: number;
  httpStatus: number | null;
  outcome: TrainingOpenAIAttemptOutcome;
  errorCode: string | null;
};

export class TrainingOpenAIError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly attempts = 0,
    readonly detailCode: string | null = null,
  ) {
    super(`Training OpenAI request failed: ${code}`);
    this.name = 'TrainingOpenAIError';
  }
}

export class TrainingOpenAIClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly baseUrl = readTrainingAlibabaBaseUrl(),
  ) {
    if (!apiKey.trim()) throw new TrainingOpenAIError('ALIBABA_API_KEY_MISSING', false);
  }

  async request<T>(input: {
    path: '/chat/completions';
    body: BodyInit;
    contentType?: string;
    clientRequestId?: string;
    signal?: AbortSignal;
    policy: TrainingOpenAIRequestPolicy;
    parse: (response: Response) => Promise<T>;
    observeResponse?: (observation: TrainingOpenAIResponseObservation) => Promise<void> | void;
    observeAttempt?: (observation: TrainingOpenAIAttemptObservation) => Promise<void> | void;
  }): Promise<TrainingOpenAIResponse<T>> {
    const startedAt = Date.now();
    const deadline = startedAt + input.policy.timeoutMs;
    let attempts = 0;

    while (attempts <= input.policy.maxRetries) {
      if (input.signal?.aborted) {
        throw new TrainingOpenAIError('OPENAI_ABORTED', true, attempts);
      }

      attempts += 1;
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        throw new TrainingOpenAIError('OPENAI_TIMEOUT', true, attempts);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      const attemptStartedAt = Date.now();
      let responseReceived = false;
      const abortRequest = () => {
        if (!responseReceived) controller.abort();
      };

      input.signal?.addEventListener('abort', abortRequest, { once: true });

      try {
        const response = await this.fetchImplementation(`${this.baseUrl}${input.path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(input.contentType ? { 'Content-Type': input.contentType } : {}),
            ...(input.clientRequestId
              ? { 'X-Client-Request-Id': input.clientRequestId }
              : {}),
          },
          body: input.body,
          signal: controller.signal,
        });
        responseReceived = true;
        const attemptObservationResponse = input.observeAttempt ? response.clone() : null;
        input.signal?.removeEventListener('abort', abortRequest);
        const requestId = boundedHeader(response.headers.get('x-request-id'));
        if (input.observeResponse) {
          await Promise.resolve(input.observeResponse({
            response: response.clone(),
            requestId,
            attempt: attempts,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
          })).catch(() => undefined);
        }

        if (!response.ok) {
          const error = statusError(response.status, attempts);
          await safelyObserveAttempt(input.observeAttempt, {
            response: attemptObservationResponse,
            clientRequestId: input.clientRequestId ?? null,
            requestId,
            attempt: attempts,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            httpStatus: response.status,
            outcome: 'provider_error',
            errorCode: error.code,
          });
          await response.body?.cancel().catch(() => undefined);

          if (!error.retryable || attempts > input.policy.maxRetries) throw error;
          await waitBeforeTrainingOpenAIRetry(
            response.headers.get('retry-after'),
            deadline,
            attempts,
            input.signal,
          );
          continue;
        }

        try {
          const value = await input.parse(response);

          await safelyObserveAttempt(input.observeAttempt, {
            response: attemptObservationResponse,
            clientRequestId: input.clientRequestId ?? null,
            requestId,
            attempt: attempts,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            httpStatus: response.status,
            outcome: 'accepted',
            errorCode: null,
          });

          return {
            value,
            requestId,
            latencyMs: Math.max(0, Date.now() - startedAt),
            attempts,
          };
        } catch (error) {
          const parsedError = error instanceof TrainingOpenAIError
            ? new TrainingOpenAIError(
                error.code,
                error.retryable,
                attempts,
                error.detailCode,
              )
            : new TrainingOpenAIError('OPENAI_MALFORMED_RESPONSE', true, attempts);

          await safelyObserveAttempt(input.observeAttempt, {
            response: attemptObservationResponse,
            clientRequestId: input.clientRequestId ?? null,
            requestId,
            attempt: attempts,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            httpStatus: response.status,
            outcome: 'local_validation_failed',
            errorCode: getTrainingOpenAIAttemptErrorCode(parsedError),
          });

          if (!parsedError.retryable || attempts > input.policy.maxRetries) throw parsedError;
          await waitBeforeTrainingOpenAIRetry(null, deadline, attempts, input.signal);
        }
      } catch (error) {
        const normalized = !responseReceived && input.signal?.aborted
          ? new TrainingOpenAIError('OPENAI_ABORTED', true, attempts)
          : normalizeFetchError(error, attempts);

        if (!responseReceived) {
          await safelyObserveAttempt(input.observeAttempt, {
            response: null,
            clientRequestId: input.clientRequestId ?? null,
            requestId: null,
            attempt: attempts,
            durationMs: Math.max(0, Date.now() - attemptStartedAt),
            httpStatus: null,
            outcome: 'transport_error',
            errorCode: normalized.code,
          });
        }

        if (!responseReceived && input.signal?.aborted) throw normalized;

        if (!normalized.retryable || attempts > input.policy.maxRetries) throw normalized;
        await waitBeforeTrainingOpenAIRetry(null, deadline, attempts, input.signal);
      } finally {
        input.signal?.removeEventListener('abort', abortRequest);
        clearTimeout(timer);
      }
    }

    throw new TrainingOpenAIError('OPENAI_RETRIES_EXHAUSTED', true, attempts);
  }
}

export function getTrainingAiMode(): TrainingAiMode {
  const mode = (process.env.TRAINING_AI_MODE ?? 'fake').trim().toLocaleLowerCase('en-US');

  if (mode !== 'fake' && mode !== 'alibaba') {
    throw new TrainingOpenAIError('TRAINING_AI_MODE_INVALID', false);
  }

  return mode;
}

export function getTrainingAlibabaApiKey() {
  const key = process.env.ALIBABA_API_KEY?.trim() ?? '';

  if (!key) throw new TrainingOpenAIError('ALIBABA_API_KEY_MISSING', false);
  return key;
}

function readTrainingAlibabaBaseUrl() {
  return (
    process.env.ASSISTANT_ALIBABA_BASE_URL?.trim() || DEFAULT_TRAINING_ALIBABA_BASE_URL
  ).replace(/\/+$/u, '');
}

export function readTrainingModel(name: string, fallback: string) {
  const model = (process.env[name] ?? '').trim() || fallback;

  if (model.length > 120) throw new TrainingOpenAIError(`${name}_INVALID`, false);
  return model;
}

export type TrainingChatCompletionMessage = {
  role: 'system' | 'user';
  content: string;
};

// JSON mode instead of strict json_schema: DashScope rejects json_schema for
// deepseek-v4.1-flash, so the schema goes into the prompt and every caller
// validates the parsed object locally.
export function createTrainingJsonChatCompletionBody(input: {
  model: string;
  instructions: string;
  schema: unknown;
  userMessages: string[];
  maxOutputTokens: number;
}) {
  const messages: TrainingChatCompletionMessage[] = [
    {
      role: 'system',
      content: [
        input.instructions,
        'Ответ — один JSON-объект без markdown и пояснений, строго по этой JSON Schema:',
        JSON.stringify(input.schema),
      ].join('\n\n'),
    },
    ...input.userMessages.map((content) => ({ role: 'user' as const, content })),
  ];

  return {
    model: input.model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: input.maxOutputTokens,
    temperature: 0.2,
    enable_thinking: false,
    stream: false,
  };
}

export type TrainingChatCompletionOutput = {
  content: string | null;
  finishReason: string | null;
};

export function readTrainingChatCompletionOutput(
  value: unknown,
): TrainingChatCompletionOutput | null {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    return null;
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;

  return {
    content: typeof choice.message.content === 'string' && choice.message.content.trim()
      ? choice.message.content
      : null,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

export function readTrainingOpenAIInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TrainingOpenAIError(`${name}_INVALID`, false);
  }

  return value;
}

function statusError(status: number, attempts: number) {
  const retryable = status === 429 || status >= 500;
  const code = status === 400
    ? 'OPENAI_INVALID_REQUEST'
    : status === 401
      ? 'OPENAI_UNAUTHORIZED'
      : status === 403
        ? 'OPENAI_FORBIDDEN'
        : status === 429
          ? 'OPENAI_RATE_LIMITED'
          : status >= 500
            ? 'OPENAI_UPSTREAM_UNAVAILABLE'
            : 'OPENAI_HTTP_ERROR';

  return new TrainingOpenAIError(code, retryable, attempts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFetchError(error: unknown, attempts: number) {
  if (error instanceof TrainingOpenAIError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new TrainingOpenAIError('OPENAI_TIMEOUT', true, attempts);
  }

  return new TrainingOpenAIError('OPENAI_NETWORK_ERROR', true, attempts);
}

export async function waitBeforeTrainingOpenAIRetry(
  retryAfter: string | null,
  deadline: number,
  attempts: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    throw new TrainingOpenAIError('OPENAI_ABORTED', true, attempts);
  }

  const delayMs = Math.min(parseRetryAfter(retryAfter) ?? 100, 2_000);

  if (Date.now() + delayMs >= deadline) {
    throw new TrainingOpenAIError('OPENAI_TIMEOUT', false, attempts);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abortRetry);
      resolve();
    }, delayMs);
    const abortRetry = () => {
      clearTimeout(timer);
      reject(new TrainingOpenAIError('OPENAI_ABORTED', true, attempts));
    };

    signal?.addEventListener('abort', abortRetry, { once: true });
  });
}

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function boundedHeader(value: string | null) {
  return value && value.length <= 160 ? value : null;
}

function getTrainingOpenAIAttemptErrorCode(error: TrainingOpenAIError) {
  return [error.code, error.detailCode].filter(Boolean).join('_').slice(0, 120);
}

async function safelyObserveAttempt(
  observer: ((observation: TrainingOpenAIAttemptObservation) => Promise<void> | void) | undefined,
  observation: TrainingOpenAIAttemptObservation,
) {
  if (!observer) return;
  try {
    await Promise.resolve(observer(observation)).catch(() => undefined);
  } finally {
    if (observation.response && !observation.response.bodyUsed) {
      await observation.response.arrayBuffer().catch(() => undefined);
    }
  }
}
