import { Injectable } from '@nestjs/common';

export const TRAINING_TELEGRAM_CLIENT = Symbol('TRAINING_TELEGRAM_CLIENT');

export type TrainingTelegramInlineKeyboard = Array<
  Array<{ text: string; callbackData: string }>
>;

export type TrainingTelegramSendMessageInput = {
  chatId: bigint;
  text: string;
  inlineKeyboard?: TrainingTelegramInlineKeyboard;
};

export type TrainingTelegramDownload = {
  body: Buffer;
  mimeType: string | null;
  sizeBytes: number;
};

export interface TrainingTelegramClient {
  sendMessage(input: TrainingTelegramSendMessageInput): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getFile(fileId: string): Promise<{ filePath: string; sizeBytes: number | null }>;
  downloadFile(filePath: string, maxBytes: number): Promise<TrainingTelegramDownload>;
}

export class TrainingTelegramClientError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Telegram request failed: ${code}`);
    this.name = 'TrainingTelegramClientError';
  }
}

@Injectable()
export class FakeTrainingTelegramClient implements TrainingTelegramClient {
  readonly sentMessages: TrainingTelegramSendMessageInput[] = [];
  readonly answeredCallbacks: Array<{ callbackQueryId: string; text?: string }> = [];
  private readonly files = new Map<
    string,
    { filePath: string; body: Buffer; mimeType: string | null }
  >();

  registerFile(
    fileId: string,
    input: { filePath?: string; body: Buffer; mimeType?: string | null },
  ) {
    this.files.set(fileId, {
      filePath: input.filePath ?? `voice/${encodeURIComponent(fileId)}.oga`,
      body: Buffer.from(input.body),
      mimeType: input.mimeType ?? 'audio/ogg',
    });
  }

  reset() {
    this.sentMessages.length = 0;
    this.answeredCallbacks.length = 0;
    this.files.clear();
  }

  async sendMessage(input: TrainingTelegramSendMessageInput) {
    this.sentMessages.push({
      ...input,
      inlineKeyboard: input.inlineKeyboard?.map((row) => row.map((button) => ({ ...button }))),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    this.answeredCallbacks.push({ callbackQueryId, ...(text ? { text } : {}) });
  }

  async getFile(fileId: string) {
    const file = this.files.get(fileId);

    if (!file) {
      throw new TrainingTelegramClientError('FAKE_FILE_NOT_FOUND', false);
    }

    return { filePath: file.filePath, sizeBytes: file.body.length };
  }

  async downloadFile(filePath: string, maxBytes: number) {
    const file = [...this.files.values()].find((candidate) => candidate.filePath === filePath);

    if (!file) {
      throw new TrainingTelegramClientError('FAKE_FILE_NOT_FOUND', false);
    }

    if (file.body.length > maxBytes) {
      throw new TrainingTelegramClientError('FILE_TOO_LARGE', false);
    }

    return {
      body: Buffer.from(file.body),
      mimeType: file.mimeType,
      sizeBytes: file.body.length,
    };
  }
}

@Injectable()
export class NativeTrainingTelegramClient implements TrainingTelegramClient {
  async sendMessage(input: TrainingTelegramSendMessageInput) {
    await this.callApi('sendMessage', {
      chat_id: input.chatId.toString(),
      text: input.text,
      ...(input.inlineKeyboard
        ? {
            reply_markup: {
              inline_keyboard: input.inlineKeyboard.map((row) =>
                row.map((button) => ({
                  text: button.text,
                  callback_data: button.callbackData,
                })),
              ),
            },
          }
        : {}),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    await this.callApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async getFile(fileId: string) {
    const result = await this.callApi('getFile', { file_id: fileId });

    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      typeof result.file_path !== 'string' ||
      !isSafeTelegramFilePath(result.file_path)
    ) {
      throw new TrainingTelegramClientError('INVALID_FILE_RESPONSE', false);
    }

    const sizeBytes =
      typeof result.file_size === 'number' &&
      Number.isSafeInteger(result.file_size) &&
      result.file_size >= 0
        ? result.file_size
        : null;

    return { filePath: result.file_path, sizeBytes };
  }

  async downloadFile(filePath: string, maxBytes: number) {
    if (!isSafeTelegramFilePath(filePath)) {
      throw new TrainingTelegramClientError('INVALID_FILE_PATH', false);
    }

    const token = getRequiredBotToken();
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`/file/bot${token}/${encodedPath}`, getTelegramApiOrigin());
    const response = await this.fetchWithRetry(
      url,
      { method: 'GET', redirect: 'error' },
      'downloadFile',
    );

    if (!response.ok) {
      throw new TrainingTelegramClientError(
        `HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));

    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new TrainingTelegramClientError('FILE_TOO_LARGE', false);
    }

    const body = await readBoundedResponse(response, maxBytes);

    return {
      body,
      mimeType: normalizeMimeType(response.headers.get('content-type')),
      sizeBytes: body.length,
    };
  }

  private async callApi(method: string, payload: Record<string, unknown>) {
    const token = getRequiredBotToken();
    const url = new URL(`/bot${token}/${method}`, getTelegramApiOrigin());
    const response = await this.fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
      },
      method,
    );
    const parsed = (await response.json().catch(() => null)) as unknown;
    const parsedRecord = isRecord(parsed) ? parsed : null;

    if (!response.ok) {
      throw new TrainingTelegramClientError(
        `HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }

    if (
      !parsedRecord ||
      parsedRecord.ok !== true ||
      !('result' in parsedRecord)
    ) {
      const errorCode =
        parsedRecord && typeof parsedRecord.error_code === 'number'
          ? parsedRecord.error_code
          : null;

      throw new TrainingTelegramClientError(
        errorCode ? `BOT_API_${errorCode}` : 'INVALID_RESPONSE',
        errorCode === 429 || Boolean(errorCode && errorCode >= 500),
      );
    }

    return parsedRecord.result as Record<string, unknown>;
  }

  private async fetchWithRetry(url: URL, init: RequestInit, operation: string) {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), getRequestTimeoutMs());

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });

        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          await response.body?.cancel().catch(() => undefined);
          await delay(100);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;

        if (attempt === 0) {
          await delay(100);
          continue;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new TrainingTelegramClientError(
      lastError instanceof DOMException && lastError.name === 'AbortError'
        ? 'TIMEOUT'
        : `${operation.toUpperCase()}_NETWORK`,
      true,
    );
  }
}

export function getTrainingTelegramTransportMode() {
  const mode = (process.env.TELEGRAM_TRANSPORT_MODE ?? 'fake').trim().toLowerCase();

  if (mode !== 'fake' && mode !== 'real') {
    throw new Error('TELEGRAM_TRANSPORT_MODE must be fake or real');
  }

  return mode;
}

export function validateTrainingTelegramRealConfig() {
  if (getTrainingTelegramTransportMode() !== 'real') return;

  for (const key of [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_USERNAME',
    'TELEGRAM_WEBHOOK_SECRET',
  ]) {
    if (!process.env[key]?.trim()) {
      throw new Error(`${key} is required in real Telegram transport mode`);
    }
  }
}

function getRequiredBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    throw new TrainingTelegramClientError('BOT_TOKEN_MISSING', false);
  }

  return token;
}

function getRequestTimeoutMs() {
  const parsed = Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS ?? 10_000);

  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 60_000 ? parsed : 10_000;
}

function getTelegramApiOrigin() {
  const testOrigin = process.env.TELEGRAM_TEST_API_ORIGIN?.trim();

  if (process.env.NODE_ENV === 'test' && testOrigin) {
    const url = new URL(testOrigin);

    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      !url.username &&
      !url.password
    ) {
      return url;
    }

    throw new Error('TELEGRAM_TEST_API_ORIGIN must be a local HTTP origin');
  }

  return new URL('https://api.telegram.org');
}

function isSafeTelegramFilePath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') &&
    !value.includes('://')
  );
}

async function readBoundedResponse(response: Response, maxBytes: number) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        throw new TrainingTelegramClientError('FILE_TOO_LARGE', false);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

function normalizeMimeType(value: string | null) {
  const mimeType = value?.split(';')[0]?.trim().toLowerCase();

  return mimeType || null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
