export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL =
  'gpt-4o-mini-transcribe-2025-12-15';
export const DEFAULT_OPENAI_EVALUATION_MODEL = 'gpt-5.6-terra';
export const DEFAULT_OPENAI_EVALUATION_REASONING = 'medium';

export type TrainingAiMode = 'fake' | 'openai';

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

export class TrainingOpenAIError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly attempts = 0,
  ) {
    super(`Training OpenAI request failed: ${code}`);
    this.name = 'TrainingOpenAIError';
  }
}

export class TrainingOpenAIClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {
    if (!apiKey.trim()) throw new TrainingOpenAIError('OPENAI_API_KEY_MISSING', false);
  }

  async request<T>(input: {
    path: '/audio/transcriptions' | '/responses';
    body: BodyInit;
    contentType?: string;
    policy: TrainingOpenAIRequestPolicy;
    parse: (response: Response) => Promise<T>;
  }): Promise<TrainingOpenAIResponse<T>> {
    const startedAt = Date.now();
    const deadline = startedAt + input.policy.timeoutMs;
    let attempts = 0;

    while (attempts <= input.policy.maxRetries) {
      attempts += 1;
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        throw new TrainingOpenAIError('OPENAI_TIMEOUT', true, attempts);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);

      try {
        const response = await this.fetchImplementation(`${this.baseUrl}${input.path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(input.contentType ? { 'Content-Type': input.contentType } : {}),
          },
          body: input.body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = statusError(response.status, attempts);
          await response.body?.cancel().catch(() => undefined);

          if (!error.retryable || attempts > input.policy.maxRetries) throw error;
          await waitBeforeRetry(response.headers.get('retry-after'), deadline, attempts);
          continue;
        }

        try {
          const value = await input.parse(response);

          return {
            value,
            requestId: boundedHeader(response.headers.get('x-request-id')),
            latencyMs: Math.max(0, Date.now() - startedAt),
            attempts,
          };
        } catch (error) {
          const parsedError = error instanceof TrainingOpenAIError
            ? new TrainingOpenAIError(error.code, error.retryable, attempts)
            : new TrainingOpenAIError('OPENAI_MALFORMED_RESPONSE', true, attempts);

          if (!parsedError.retryable || attempts > input.policy.maxRetries) throw parsedError;
          await waitBeforeRetry(null, deadline, attempts);
        }
      } catch (error) {
        const normalized = normalizeFetchError(error, attempts);

        if (!normalized.retryable || attempts > input.policy.maxRetries) throw normalized;
        await waitBeforeRetry(null, deadline, attempts);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new TrainingOpenAIError('OPENAI_RETRIES_EXHAUSTED', true, attempts);
  }
}

export function getTrainingAiMode(): TrainingAiMode {
  const mode = (process.env.TRAINING_AI_MODE ?? 'fake').trim().toLocaleLowerCase('en-US');

  if (mode !== 'fake' && mode !== 'openai') {
    throw new TrainingOpenAIError('TRAINING_AI_MODE_INVALID', false);
  }

  return mode;
}

export function getOpenAIApiKey() {
  const key = process.env.OPENAI_API_KEY?.trim() ?? '';

  if (!key) throw new TrainingOpenAIError('OPENAI_API_KEY_MISSING', false);
  return key;
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

function normalizeFetchError(error: unknown, attempts: number) {
  if (error instanceof TrainingOpenAIError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new TrainingOpenAIError('OPENAI_TIMEOUT', true, attempts);
  }

  return new TrainingOpenAIError('OPENAI_NETWORK_ERROR', true, attempts);
}

async function waitBeforeRetry(
  retryAfter: string | null,
  deadline: number,
  attempts: number,
) {
  const delayMs = Math.min(parseRetryAfter(retryAfter) ?? 100, 2_000);

  if (Date.now() + delayMs >= deadline) {
    throw new TrainingOpenAIError('OPENAI_TIMEOUT', false, attempts);
  }

  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
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
