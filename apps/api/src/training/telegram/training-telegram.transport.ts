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
      throw new Error('Telegram Bot API transport is not configured');
    }
    const response = await fetch(
      `${this.apiBaseUrl}/bot${encodeURIComponent(this.botToken)}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!response.ok || payload?.ok !== true) {
      const description =
        typeof payload?.description === 'string'
          ? payload.description.slice(0, 500)
          : `HTTP ${response.status}`;
      throw new Error(`Telegram Bot API ${method} failed: ${description}`);
    }
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
