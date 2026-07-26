import { Injectable } from '@nestjs/common';

import { TrainingTelegramConfig } from './training-telegram.config';

export const TRAINING_TELEGRAM_TRANSPORT = Symbol(
  'TRAINING_TELEGRAM_TRANSPORT',
);

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
    }, 5_000);
    timeout.unref();

    let response: Response;
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
    } catch (error) {
      if (error instanceof TrainingTelegramTransportError) throw error;
      throw new TrainingTelegramTransportError(
        timedOut || isAbortError(error) ? 'TIMEOUT' : 'NETWORK_ERROR',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    type TelegramResponsePayload = {
      ok?: boolean;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    let payload: TelegramResponsePayload | null = null;
    let invalidJson = false;
    try {
      payload = (await response.json()) as TelegramResponsePayload;
    } catch {
      invalidJson = true;
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
