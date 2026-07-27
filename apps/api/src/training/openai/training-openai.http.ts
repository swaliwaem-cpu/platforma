import { Inject, Injectable } from '@nestjs/common';

import { TrainingOpenAiConfig } from './training-openai.config';

export const TRAINING_OPENAI_HTTP_OPTIONS = Symbol(
  'TRAINING_OPENAI_HTTP_OPTIONS',
);

export type TrainingOpenAiHttpOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export type TrainingOpenAiHttpRequest = {
  path: string;
  timeoutMs: number;
  maxRetries: number;
  headers?: Record<string, string>;
  buildBody: () => BodyInit;
  validateResponse?: (response: TrainingOpenAiHttpResponse) => void;
};

export type TrainingOpenAiHttpResponse = {
  status: number;
  requestId: string | null;
  bodyText: string;
  latencyMs: number;
  retryCount: number;
};

export class TrainingOpenAiRequestError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly ambiguous: boolean,
    readonly status: number | null,
    readonly requestId: string | null,
    readonly retryCount: number,
    message: string,
  ) {
    super(message);
    this.name = 'TrainingOpenAiRequestError';
  }
}

@Injectable()
export class TrainingOpenAiHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly config: TrainingOpenAiConfig,
    @Inject(TRAINING_OPENAI_HTTP_OPTIONS)
    options: TrainingOpenAiHttpOptions,
  ) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com').replace(
      /\/+$/u,
      '',
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => performance.now());
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  async request(input: TrainingOpenAiHttpRequest) {
    if (!this.config.apiKey) {
      throw new TrainingOpenAiRequestError(
        'OPENAI_API_KEY_MISSING',
        false,
        false,
        null,
        null,
        0,
        'OpenAI real provider is not configured',
      );
    }

    const startedAt = this.now();
    const deadlineAt = startedAt + input.timeoutMs;
    let retryCount = 0;

    for (;;) {
      const remainingMs = deadlineAt - this.now();
      if (remainingMs <= 0) {
        throw deadlineExceeded(retryCount);
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1, Math.ceil(remainingMs)),
      );
      let responseStatus: number | null = null;
      let responseRequestId: string | null = null;
      let responseRetryDelayMs: number | null = null;

      try {
        const response = await this.fetchImpl(`${this.baseUrl}${input.path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            ...input.headers,
          },
          body: input.buildBody(),
          signal: controller.signal,
        });
        const requestId = response.headers.get('x-request-id');
        responseStatus = response.status;
        responseRequestId = requestId;
        const bodyText = await readBoundedResponseText(
          response,
          this.config.maxResponseBytes,
        );
        if (this.now() >= deadlineAt) {
          throw deadlineExceeded(retryCount, requestId);
        }

        if (response.ok) {
          const result = {
            status: response.status,
            requestId,
            bodyText,
            latencyMs: Math.max(0, Math.round(this.now() - startedAt)),
            retryCount,
          } satisfies TrainingOpenAiHttpResponse;
          input.validateResponse?.(result);
          if (this.now() >= deadlineAt) {
            throw deadlineExceeded(retryCount, requestId);
          }
          return result;
        }

        const retryable = response.status === 429 || response.status >= 500;
        if (retryable) {
          responseRetryDelayMs = readRetryDelayMs(response, retryCount);
        }
        throw new TrainingOpenAiRequestError(
          `OPENAI_HTTP_${response.status}`,
          retryable,
          false,
          response.status,
          requestId,
          retryCount,
          `OpenAI request failed with HTTP ${response.status}`,
        );
      } catch (error) {
        if (error instanceof TrainingOpenAiRequestError) {
          if (error.retryable && retryCount < input.maxRetries) {
            const delayMs =
              responseRetryDelayMs ??
              Math.min(5_000, 250 * 2 ** retryCount);
            retryCount += 1;
            await this.sleepBeforeDeadline(
              delayMs,
              deadlineAt,
              retryCount,
              error.requestId,
            );
            continue;
          }
          throw new TrainingOpenAiRequestError(
            error.code,
            error.retryable,
            error.ambiguous,
            error.status ?? responseStatus,
            error.requestId ?? responseRequestId,
            retryCount,
            error.message,
          );
        }
        if (error instanceof ResponseTooLargeError) {
          throw new TrainingOpenAiRequestError(
            'OPENAI_RESPONSE_TOO_LARGE',
            false,
            false,
            null,
            null,
            retryCount,
            'OpenAI response exceeded the configured byte limit',
          );
        }

        const aborted = controller.signal.aborted;
        if (aborted || this.now() >= deadlineAt) {
          throw deadlineExceeded(retryCount, responseRequestId);
        }
        if (retryCount < input.maxRetries) {
          const delayMs = Math.min(5_000, 250 * 2 ** retryCount);
          retryCount += 1;
          await this.sleepBeforeDeadline(
            delayMs,
            deadlineAt,
            retryCount,
            responseRequestId,
          );
          continue;
        }
        throw new TrainingOpenAiRequestError(
          'OPENAI_NETWORK_ERROR',
          true,
          true,
          null,
          null,
          retryCount,
          'OpenAI network request failed with an ambiguous outcome',
        );
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private async sleepBeforeDeadline(
    delayMs: number,
    deadlineAt: number,
    retryCount: number,
    requestId: string | null,
  ) {
    const remainingMs = deadlineAt - this.now();
    if (remainingMs <= 0 || delayMs >= remainingMs) {
      throw deadlineExceeded(retryCount, requestId);
    }
    await this.sleep(delayMs);
    if (this.now() >= deadlineAt) {
      throw deadlineExceeded(retryCount, requestId);
    }
  }
}

class ResponseTooLargeError extends Error {}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ResponseTooLargeError();
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function readRetryDelayMs(response: Response, retryCount: number) {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(30_000, Math.round(seconds * 1_000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(30_000, Math.max(0, retryAt - Date.now()));
    }
  }
  return Math.min(5_000, 250 * 2 ** retryCount);
}

function deadlineExceeded(
  retryCount: number,
  requestId: string | null = null,
) {
  return new TrainingOpenAiRequestError(
    'DEADLINE_EXCEEDED',
    false,
    true,
    null,
    requestId,
    retryCount,
    'OpenAI request reached the total deadline with an ambiguous outcome',
  );
}
