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
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {
    if (!apiKey.trim()) throw new TrainingOpenAIError('OPENAI_API_KEY_MISSING', false);
  }

  async request<T>(input: {
    path: '/audio/transcriptions' | '/responses';
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
            errorCode: parsedError.code,
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
