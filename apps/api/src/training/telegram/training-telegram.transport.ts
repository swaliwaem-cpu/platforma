import { Injectable } from '@nestjs/common';

import { TrainingTelegramConfig } from './training-telegram.config';

export const TRAINING_TELEGRAM_TRANSPORT = Symbol(
  'TRAINING_TELEGRAM_TRANSPORT',
);

const TELEGRAM_RESPONSE_MAX_BYTES = 64 * 1024;

export type TelegramInlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type TelegramInlineKeyboard = {
  inline_keyboard: TelegramInlineButton[][];
};

export type TrainingTelegramSendMessage = {
  idempotencyKey: string;
  chatId: string;
  text: string;
  replyMarkup?: TelegramInlineKeyboard;
};

export type TrainingTelegramAnswerCallback = {
  idempotencyKey: string;
  callbackQueryId: string;
  text?: string;
};

export type TrainingTelegramDelivery =
  | ({ operation: 'SEND_MESSAGE' } & TrainingTelegramSendMessage)
  | ({ operation: 'ANSWER_CALLBACK' } & TrainingTelegramAnswerCallback);

export interface TrainingTelegramTransport {
  sendMessage(input: TrainingTelegramSendMessage): Promise<void>;
  answerCallbackQuery(input: TrainingTelegramAnswerCallback): Promise<void>;
}

export type TrainingTelegramTransportErrorCode =
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'PERMANENT_CLIENT_ERROR'
  | 'INVALID_RESPONSE'
  | 'NOT_CONFIGURED';

export class TrainingTelegramTransportError extends Error {
  constructor(
    readonly code: TrainingTelegramTransportErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(`Telegram transport failed with ${code}`);
    this.name = 'TrainingTelegramTransportError';
  }
}

@Injectable()
export class FakeTrainingTelegramTransport
  implements TrainingTelegramTransport
{
  readonly deliveries: TrainingTelegramDelivery[] = [];
  private readonly deliveredKeys = new Set<string>();

  async sendMessage(input: TrainingTelegramSendMessage) {
    if (this.deliveredKeys.has(input.idempotencyKey)) return;
    this.deliveredKeys.add(input.idempotencyKey);
    this.deliveries.push({ operation: 'SEND_MESSAGE', ...structuredClone(input) });
  }

  async answerCallbackQuery(input: TrainingTelegramAnswerCallback) {
    if (this.deliveredKeys.has(input.idempotencyKey)) return;
    this.deliveredKeys.add(input.idempotencyKey);
    this.deliveries.push({
      operation: 'ANSWER_CALLBACK',
      ...structuredClone(input),
    });
  }

  clear() {
    this.deliveries.length = 0;
    this.deliveredKeys.clear();
  }
}

export class FetchTrainingTelegramTransport
  implements TrainingTelegramTransport
{
  constructor(
    private readonly botToken: string,
    private readonly apiBaseUrl = 'https://api.telegram.org',
    private readonly requestTimeoutMs = 5_000,
  ) {}

  async sendMessage(input: TrainingTelegramSendMessage) {
    await this.call('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
    });
  }

  async answerCallbackQuery(input: TrainingTelegramAnswerCallback) {
    await this.call('answerCallbackQuery', {
      callback_query_id: input.callbackQueryId,
      ...(input.text ? { text: input.text } : {}),
    });
  }

  private async call(method: string, body: Record<string, unknown>) {
    if (!this.botToken) {
      throw new TrainingTelegramTransportError('NOT_CONFIGURED', false);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    timeout.unref();

    let response: Response;
    let payload: TelegramResponsePayload | null = null;
    let invalidJson = false;
    try {
      response = await fetch(
        `${this.apiBaseUrl}/bot${encodeURIComponent(this.botToken)}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const parsed = await waitForTelegramResponseBody(
        readTelegramResponsePayload(response),
        controller.signal,
      );
      payload = parsed.payload;
      invalidJson = parsed.invalidJson;
    } catch (error) {
      if (error instanceof TrainingTelegramTransportError) throw error;
      throw new TrainingTelegramTransportError(
        timedOut || isAbortError(error) ? 'TIMEOUT' : 'NETWORK_ERROR',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    const errorCode =
      typeof payload?.error_code === 'number'
        ? payload.error_code
        : response.status;
    if (response.status === 429 || errorCode === 429) {
      const retryAfterSeconds = payload?.parameters?.retry_after;
      const retryAfterMs =
        typeof retryAfterSeconds === 'number' &&
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds > 0
          ? Math.ceil(retryAfterSeconds * 1_000)
          : undefined;
      throw new TrainingTelegramTransportError(
        'RATE_LIMITED',
        true,
        retryAfterMs,
      );
    }
    if (response.status >= 500 && response.status <= 599) {
      throw new TrainingTelegramTransportError('SERVER_ERROR', true);
    }
    if (response.status >= 400 && response.status <= 499) {
      throw new TrainingTelegramTransportError(
        'PERMANENT_CLIENT_ERROR',
        false,
      );
    }
    if (invalidJson || !payload || typeof payload.ok !== 'boolean') {
      throw new TrainingTelegramTransportError('INVALID_RESPONSE', true);
    }
    if (response.ok && payload.ok === true) return;
    if (errorCode >= 400 && errorCode <= 499) {
      throw new TrainingTelegramTransportError(
        'PERMANENT_CLIENT_ERROR',
        false,
      );
    }
    throw new TrainingTelegramTransportError('INVALID_RESPONSE', true);
  }
}

type TelegramResponsePayload = {
  ok?: boolean;
  error_code?: number;
  parameters?: { retry_after?: number };
};

async function readTelegramResponsePayload(response: Response): Promise<{
  payload: TelegramResponsePayload | null;
  invalidJson: boolean;
}> {
  const contentLength = response.headers?.get?.('content-length');
  if (
    contentLength &&
    (/^\d+$/u.test(contentLength) === false ||
      BigInt(contentLength) > BigInt(TELEGRAM_RESPONSE_MAX_BYTES))
  ) {
    throw new TrainingTelegramTransportError('INVALID_RESPONSE', true);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    try {
      const payload = (await response.json()) as TelegramResponsePayload;
      if (
        Buffer.byteLength(JSON.stringify(payload), 'utf8') >
        TELEGRAM_RESPONSE_MAX_BYTES
      ) {
        throw new TrainingTelegramTransportError('INVALID_RESPONSE', true);
      }
      return {
        payload,
        invalidJson: false,
      };
    } catch (error) {
      if (error instanceof TrainingTelegramTransportError) throw error;
      return { payload: null, invalidJson: true };
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > TELEGRAM_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TrainingTelegramTransportError('INVALID_RESPONSE', true);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(
    chunks.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    ),
    totalBytes,
  ).toString('utf8');
  try {
    return {
      payload: JSON.parse(body) as TelegramResponsePayload,
      invalidJson: false,
    };
  } catch {
    return { payload: null, invalidJson: true };
  }
}

function waitForTelegramResponseBody<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function abortError() {
  const error = new Error('Telegram response body timed out');
  error.name = 'AbortError';
  return error;
}

export function createTrainingTelegramTransport(
  config: TrainingTelegramConfig,
  fakeTransport: FakeTrainingTelegramTransport,
): TrainingTelegramTransport {
  return config.usesFakeTransport
    ? fakeTransport
    : new FetchTrainingTelegramTransport(config.botToken);
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
