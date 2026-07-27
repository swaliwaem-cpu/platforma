import { Injectable } from '@nestjs/common';

import { TrainingTelegramConfig } from '../telegram/training-telegram.config';
import { TrainingAudioConfig } from './training-audio.config';
import { TrainingAudioError } from './training-audio.error';

export const TRAINING_TELEGRAM_AUDIO_PROVIDER = Symbol(
  'TRAINING_TELEGRAM_AUDIO_PROVIDER',
);

const TELEGRAM_RESPONSE_MAX_BYTES = 64 * 1024;
const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const ALLOWED_AUDIO_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'application/ogg',
  'audio/ogg',
  'video/ogg',
]);

export type TrainingTelegramAudioDownloadInput = {
  fileId: string;
  declaredSizeBytes: bigint | null;
  declaredDurationSeconds: number | null;
};

export type TrainingTelegramAudioDownloadResult = {
  body: Buffer;
  mimeType: string;
};

export interface TrainingTelegramAudioProvider {
  downloadVoice(
    input: TrainingTelegramAudioDownloadInput,
  ): Promise<TrainingTelegramAudioDownloadResult>;
}

@Injectable()
export class FakeTrainingTelegramAudioProvider
  implements TrainingTelegramAudioProvider
{
  async downloadVoice(
    input: TrainingTelegramAudioDownloadInput,
  ): Promise<TrainingTelegramAudioDownloadResult> {
    if (input.fileId.includes('[[download:retryable]]')) {
      throw new TrainingAudioError('TELEGRAM_NETWORK_ERROR', true);
    }
    if (input.fileId.includes('[[download:permanent]]')) {
      throw new TrainingAudioError(
        'TELEGRAM_PERMANENT_CLIENT_ERROR',
        false,
      );
    }
    return {
      body: createSilentWaveFixture(),
      mimeType: 'audio/wav',
    };
  }
}

export class FetchTrainingTelegramAudioProvider
  implements TrainingTelegramAudioProvider
{
  constructor(
    private readonly botToken: string,
    private readonly config: TrainingAudioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async downloadVoice(
    input: TrainingTelegramAudioDownloadInput,
  ): Promise<TrainingTelegramAudioDownloadResult> {
    if (!this.botToken) {
      throw new TrainingAudioError(
        'TELEGRAM_PERMANENT_CLIENT_ERROR',
        false,
      );
    }

    const metadata = await this.getFile(input.fileId);
    if (
      metadata.fileSize !== null &&
      metadata.fileSize > BigInt(this.config.maxSegmentBytes)
    ) {
      throw new TrainingAudioError('AUDIO_SIZE_LIMIT_EXCEEDED', false);
    }
    if (
      input.declaredSizeBytes !== null &&
      input.declaredSizeBytes > BigInt(this.config.maxSegmentBytes)
    ) {
      throw new TrainingAudioError('AUDIO_SIZE_LIMIT_EXCEEDED', false);
    }
    if (
      input.declaredDurationSeconds !== null &&
      input.declaredDurationSeconds > this.config.maxAnswerDurationSeconds
    ) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }

    return this.requestWithTimeout(
      this.buildFileUrl(metadata.filePath),
      { method: 'GET' },
      async (response) => {
        if (response.status === 429) {
          throw new TrainingAudioError(
            'TELEGRAM_RATE_LIMITED',
            true,
            readRetryAfterHeader(response.headers),
          );
        }
        if (response.status >= 500) {
          throw new TrainingAudioError('TELEGRAM_SERVER_ERROR', true);
        }
        if (response.status >= 400 || !response.ok) {
          throw new TrainingAudioError(
            'TELEGRAM_PERMANENT_CLIENT_ERROR',
            false,
          );
        }

        const mimeType = normalizeContentType(
          response.headers.get('content-type'),
        );
        if (!ALLOWED_AUDIO_CONTENT_TYPES.has(mimeType)) {
          throw new TrainingAudioError(
            'AUDIO_CONTENT_TYPE_INVALID',
            false,
          );
        }
        const contentLength = readContentLength(
          response.headers.get('content-length'),
          this.config.maxSegmentBytes,
        );
        const body = await readBoundedBody(
          response,
          this.config.maxSegmentBytes,
        );
        const actualSize = BigInt(body.length);
        if (
          (contentLength !== null && actualSize !== contentLength) ||
          (metadata.fileSize !== null &&
            actualSize !== metadata.fileSize) ||
          (input.declaredSizeBytes !== null &&
            actualSize !== input.declaredSizeBytes)
        ) {
          throw new TrainingAudioError(
            'AUDIO_BYTE_COUNT_MISMATCH',
            true,
          );
        }
        assertOggOpus(body);
        return { body, mimeType: 'audio/ogg' };
      },
    );
  }

  private async getFile(fileId: string) {
    return this.requestWithTimeout(
      buildTelegramUrl(
        `/bot${encodeURIComponent(this.botToken)}/getFile`,
      ),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
      },
      async (response) => {
        if (response.status === 429) {
          const payload = await readTelegramJson(response).catch(
            () => null,
          );
          throw new TrainingAudioError(
            'TELEGRAM_RATE_LIMITED',
            true,
            readTelegramRetryAfter(payload) ??
              readRetryAfterHeader(response.headers),
          );
        }
        if (response.status >= 500) {
          throw new TrainingAudioError('TELEGRAM_SERVER_ERROR', true);
        }
        if (response.status >= 400) {
          throw new TrainingAudioError(
            'TELEGRAM_PERMANENT_CLIENT_ERROR',
            false,
          );
        }
        const payload = await readTelegramJson(response);
        const errorCode =
          typeof payload?.error_code === 'number'
            ? payload.error_code
            : response.status;
        if (errorCode === 429) {
          throw new TrainingAudioError(
            'TELEGRAM_RATE_LIMITED',
            true,
            readTelegramRetryAfter(payload),
          );
        }
        if (errorCode >= 500) {
          throw new TrainingAudioError('TELEGRAM_SERVER_ERROR', true);
        }
        if (errorCode >= 400) {
          throw new TrainingAudioError(
            'TELEGRAM_PERMANENT_CLIENT_ERROR',
            false,
          );
        }
        const result = asRecord(payload?.result);
        if (payload?.ok !== true || !result) {
          throw new TrainingAudioError(
            'TELEGRAM_INVALID_RESPONSE',
            true,
          );
        }
        const filePath = result.file_path;
        if (
          typeof filePath !== 'string' ||
          !isSafeTelegramFilePath(filePath)
        ) {
          throw new TrainingAudioError(
            'TELEGRAM_INVALID_FILE_PATH',
            false,
          );
        }
        const fileSize = readOptionalPositiveBigInt(result.file_size);
        return { filePath, fileSize };
      },
    );
  }

  private async requestWithTimeout<T>(
    url: URL,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ) {
    assertAllowedTelegramUrl(url);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.downloadTimeoutMs);
    timeout.unref();

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        throw new TrainingAudioError(
          'TELEGRAM_REDIRECT_BLOCKED',
          false,
        );
      }
      const responseUrl = response.url
        ? readResponseUrl(response.url)
        : url;
      assertAllowedTelegramUrl(responseUrl);
      return await consume(response);
    } catch (error) {
      if (error instanceof TrainingAudioError) throw error;
      throw new TrainingAudioError(
        timedOut || isAbortError(error)
          ? 'TELEGRAM_TIMEOUT'
          : 'TELEGRAM_NETWORK_ERROR',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildFileUrl(filePath: string) {
    if (!isSafeTelegramFilePath(filePath)) {
      throw new TrainingAudioError(
        'TELEGRAM_INVALID_FILE_PATH',
        false,
      );
    }
    const encodedPath = filePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return buildTelegramUrl(
      `/file/bot${encodeURIComponent(this.botToken)}/${encodedPath}`,
    );
  }
}

export function createTrainingTelegramAudioProvider(
  telegramConfig: TrainingTelegramConfig,
  audioConfig: TrainingAudioConfig,
  fakeProvider: FakeTrainingTelegramAudioProvider,
): TrainingTelegramAudioProvider {
  return telegramConfig.usesFakeTransport
    ? fakeProvider
    : new FetchTrainingTelegramAudioProvider(
        telegramConfig.botToken,
        audioConfig,
      );
}

async function readTelegramJson(response: Response) {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new TrainingAudioError('TELEGRAM_INVALID_RESPONSE', true);
  }
  if (Buffer.byteLength(text, 'utf8') > TELEGRAM_RESPONSE_MAX_BYTES) {
    throw new TrainingAudioError('TELEGRAM_INVALID_RESPONSE', true);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new TrainingAudioError('TELEGRAM_INVALID_RESPONSE', true);
  }
}

async function readBoundedBody(response: Response, maximumBytes: number) {
  if (!response.body) {
    throw new TrainingAudioError('AUDIO_CONTENT_LENGTH_INVALID', true);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().then(
          () => true,
          () => false,
        );
        throw new TrainingAudioError('AUDIO_SIZE_LIMIT_EXCEEDED', false);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof TrainingAudioError) throw error;
    throw new TrainingAudioError('TELEGRAM_NETWORK_ERROR', true);
  }
  if (total === 0) {
    throw new TrainingAudioError('AUDIO_CONTENT_LENGTH_INVALID', true);
  }
  return Buffer.concat(chunks, total);
}

function readContentLength(value: string | null, maximumBytes: number) {
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) {
    throw new TrainingAudioError('AUDIO_CONTENT_LENGTH_INVALID', true);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new TrainingAudioError('AUDIO_CONTENT_LENGTH_INVALID', true);
  }
  if (parsed > BigInt(maximumBytes)) {
    throw new TrainingAudioError('AUDIO_SIZE_LIMIT_EXCEEDED', false);
  }
  return parsed;
}

function normalizeContentType(value: string | null) {
  return (value ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
}

function assertOggOpus(body: Buffer) {
  if (
    body.length < 32 ||
    body.subarray(0, 4).toString('ascii') !== 'OggS' ||
    body.indexOf(Buffer.from('OpusHead', 'ascii')) < 0
  ) {
    throw new TrainingAudioError('AUDIO_CONTAINER_INVALID', false);
  }
}

function isSafeTelegramFilePath(value: string) {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    !/^[A-Za-z0-9._/-]+$/u.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  );
}

function buildTelegramUrl(path: string) {
  const url = new URL(path, TELEGRAM_API_ORIGIN);
  assertAllowedTelegramUrl(url);
  return url;
}

function readResponseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    throw new TrainingAudioError(
      'TELEGRAM_REDIRECT_BLOCKED',
      false,
    );
  }
}

function assertAllowedTelegramUrl(url: URL) {
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.telegram.org' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.origin !== TELEGRAM_API_ORIGIN
  ) {
    throw new TrainingAudioError(
      'TELEGRAM_REDIRECT_BLOCKED',
      false,
    );
  }
}

function readOptionalPositiveBigInt(value: unknown) {
  if (value === undefined || value === null) return null;
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^\d+$/u.test(value))
  ) {
    return BigInt(value);
  }
  throw new TrainingAudioError('TELEGRAM_INVALID_RESPONSE', true);
}

function readTelegramRetryAfter(payload: Record<string, unknown> | null) {
  const parameters = asRecord(payload?.parameters);
  const seconds = parameters?.retry_after;
  return typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    seconds > 0
    ? Math.ceil(seconds * 1_000)
    : undefined;
}

function readRetryAfterHeader(headers: Headers) {
  const value = headers.get('retry-after');
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0
    ? seconds * 1_000
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function createSilentWaveFixture() {
  const sampleRate = 16_000;
  const samples = sampleRate / 4;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
