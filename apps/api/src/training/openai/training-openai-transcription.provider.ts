import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { FilesService } from '../../files/files.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TrainingTranscriptionInput,
  TrainingTranscriptionProvider,
} from '../training-attempt.providers';
import { TrainingAudioError } from '../audio/training-audio.error';
import { TrainingOpenAiConfig } from './training-openai.config';
import {
  TrainingOpenAiHttpClient,
  TrainingOpenAiRequestError,
} from './training-openai.http';
import { buildTrainingVocabularyPrompt } from './training-openai-vocabulary';

const WAV_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
]);
const MAX_TRANSCRIPT_CHARACTERS = 120_000;
const MAX_LANGUAGE_CHARACTERS = 16;
const MAX_MODEL_ID_CHARACTERS = 120;
const MAX_REQUEST_ID_CHARACTERS = 160;
const MAX_STORAGE_READ_TIMEOUT_MS = 30_000;

@Injectable()
export class OpenAiTrainingTranscriptionProvider
  implements TrainingTranscriptionProvider
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly config: TrainingOpenAiConfig,
    private readonly http: TrainingOpenAiHttpClient,
  ) {}

  async transcribe(input: TrainingTranscriptionInput) {
    const audio = input.audio;
    if (!audio) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_AUDIO_MISSING',
        'Normalized answer audio is required',
      );
    }

    const answer = await this.prisma.trainingAnswer.findUnique({
      where: { id: input.answerId },
      select: {
        id: true,
        mergedAudioFileId: true,
        mergedAudioFile: {
          select: {
            id: true,
            bucket: true,
            key: true,
            mimeType: true,
            sizeBytes: true,
            checksum: true,
          },
        },
      },
    });
    const storedFile = answer?.mergedAudioFile;
    if (
      !storedFile ||
      answer.mergedAudioFileId !== audio.fileId ||
      storedFile.id !== audio.fileId ||
      storedFile.bucket !== audio.bucket ||
      storedFile.key !== audio.key ||
      storedFile.mimeType !== audio.mimeType ||
      Number(storedFile.sizeBytes) !== audio.sizeBytes ||
      storedFile.checksum !== audio.checksum
    ) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_AUDIO_OWNERSHIP_INVALID',
        'Normalized audio metadata does not match the persisted answer file',
      );
    }
    if (
      !WAV_MIME_TYPES.has(audio.mimeType.toLowerCase()) ||
      audio.sizeBytes <= 0 ||
      audio.sizeBytes > this.config.transcriptionMaxBytes ||
      !/^[0-9a-f]{64}$/u.test(audio.checksum)
    ) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_AUDIO_INVALID',
        'Normalized audio metadata is invalid',
      );
    }

    const storedAudio = await this.readPersistedAudio(storedFile);
    const buffer = storedAudio.buffer;
    if (
      buffer.length !== audio.sizeBytes ||
      createHash('sha256').update(buffer).digest('hex') !== audio.checksum
    ) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_AUDIO_CHECKSUM_MISMATCH',
        'Normalized audio content does not match persisted metadata',
      );
    }
    assertNormalizedWav(buffer);

    const requestedModelId = input.review
      ? this.config.transcriptionReviewModel
      : this.config.transcriptionModel;
    const vocabularyPrompt = input.approvedVocabulary
      ? buildTrainingVocabularyPrompt(input.approvedVocabulary.terms)
      : '';
    const response = await this.http.request({
      path: '/v1/audio/transcriptions',
      timeoutMs: this.config.transcriptionTimeoutMs,
      maxRetries: this.config.transcriptionMaxRetries,
      buildBody: () => {
        const form = new FormData();
        form.set(
          'file',
          new Blob([new Uint8Array(buffer)], { type: 'audio/wav' }),
          `${input.answerId}.wav`,
        );
        form.set('model', requestedModelId);
        form.set('language', 'ru');
        form.set('response_format', 'json');
        if (vocabularyPrompt) form.set('prompt', vocabularyPrompt);
        return form;
      },
      validateResponse: ({ bodyText }) => {
        const candidate = parseJsonObject(
          bodyText,
          'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
        );
        readRequiredString(candidate, 'text');
      },
    });
    const payload = parseJsonObject(
      response.bodyText,
      'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
    );
    const transcript = readRequiredString(payload, 'text').trim();
    if (!transcript) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_EMPTY',
        'OpenAI transcription response was empty',
      );
    }
    if (
      Array.from(transcript).length > MAX_TRANSCRIPT_CHARACTERS ||
      transcript.includes('\u0000') ||
      containsUnpairedSurrogate(transcript)
    ) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_TEXT_INVALID',
        'OpenAI transcription text is too long or contains invalid characters',
      );
    }
    if ([...transcript].length < 2) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_TOO_SHORT',
        'OpenAI transcription text is suspiciously short',
      );
    }

    const providedLanguage = readOptionalBoundedString(
      payload,
      'language',
      MAX_LANGUAGE_CHARACTERS,
    );
    const language =
      providedLanguage === null
        ? 'ru'
        : (readBoundedMetadataString(
            providedLanguage.toLowerCase(),
            'language',
            MAX_LANGUAGE_CHARACTERS,
          ) ?? 'ru');
    const actualModelId = readOptionalBoundedString(
      payload,
      'model',
      MAX_MODEL_ID_CHARACTERS,
    );
    const requestId = readBoundedMetadataString(
      response.requestId,
      'requestId',
      MAX_REQUEST_ID_CHARACTERS,
    );
    const usage = isRecord(payload.usage) ? payload.usage : undefined;
    if (usage) assertJsonValueSafe(usage);

    return {
      transcript,
      language,
      provider: 'openai',
      requestedModelId,
      actualModelId,
      requestId,
      wordCount: countWords(transcript),
      usage,
      latencyMs: response.latencyMs,
      retryCount: response.retryCount,
      responseStatus: 'completed',
    };
  }

  private async readPersistedAudio(
    storedFile: Parameters<FilesService['readStoredFile']>[0],
  ) {
    const timeoutMs = Math.max(
      1,
      Math.min(
        this.config.transcriptionTimeoutMs,
        MAX_STORAGE_READ_TIMEOUT_MS,
      ),
    );
    const deadlineAt = Date.now() + timeoutMs;
    let retryCount = 0;

    for (;;) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new TrainingAudioError('AUDIO_STORAGE_FAILED', true);
      }
      const controller = new AbortController();
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new TrainingAudioError('AUDIO_STORAGE_FAILED', true));
        }, remainingMs);
      });

      try {
        const buffer = await Promise.race([
          this.files.readStoredFile(storedFile, {
            signal: controller.signal,
            privateTrainingAudio: true,
          }),
          deadline,
        ]);
        return { buffer };
      } catch (error) {
        const retryable = isRetryableStorageReadError(error);
        if (
          retryable &&
          retryCount < this.config.transcriptionMaxRetries
        ) {
          const delayMs = Math.min(
            250 * 2 ** retryCount,
            deadlineAt - Date.now() - 1,
          );
          if (delayMs > 0) {
            retryCount += 1;
            await sleep(delayMs);
            continue;
          }
        }
        throw new TrainingAudioError('AUDIO_STORAGE_FAILED', retryable);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }
}

function assertNormalizedWav(buffer: Buffer) {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw providerValidationError(
      'OPENAI_TRANSCRIPTION_WAV_INVALID',
      'Normalized audio is not a WAV file',
    );
  }

  let offset = 12;
  let format:
    | {
        audioFormat: number;
        channels: number;
        sampleRate: number;
        bitsPerSample: number;
      }
    | undefined;
  let hasData = false;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) break;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(dataOffset),
        channels: buffer.readUInt16LE(dataOffset + 2),
        sampleRate: buffer.readUInt32LE(dataOffset + 4),
        bitsPerSample: buffer.readUInt16LE(dataOffset + 14),
      };
    }
    if (chunkId === 'data' && chunkSize > 0) hasData = true;
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (
    !format ||
    !hasData ||
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 16_000 ||
    format.bitsPerSample !== 16
  ) {
    throw providerValidationError(
      'OPENAI_TRANSCRIPTION_WAV_NOT_NORMALIZED',
      'WAV must be mono 16 kHz 16-bit PCM',
    );
  }
}

function parseJsonObject(body: string, code: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Converted to a provider-safe error below.
  }
  throw providerValidationError(code, 'OpenAI response is not a JSON object');
}

function readRequiredString(value: Record<string, unknown>, key: string) {
  if (typeof value[key] !== 'string') {
    throw providerValidationError(
      'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
      `OpenAI response field ${key} is invalid`,
    );
  }
  return value[key];
}

function readOptionalBoundedString(
  value: Record<string, unknown>,
  key: string,
  maximumCharacters: number,
) {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== 'string') {
    throw providerValidationError(
      'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
      `OpenAI response field ${key} is invalid`,
    );
  }
  return readBoundedMetadataString(candidate, key, maximumCharacters);
}

function readBoundedMetadataString(
  value: string | null,
  key: string,
  maximumCharacters: number,
) {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (
    Array.from(normalized).length > maximumCharacters ||
    normalized.includes('\u0000') ||
    containsUnpairedSurrogate(normalized)
  ) {
    throw providerValidationError(
      'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
      `OpenAI response field ${key} is invalid`,
    );
  }
  return normalized;
}

function assertJsonValueSafe(value: unknown) {
  const pending = [value];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate === 'string') {
      if (
        candidate.includes('\u0000') ||
        containsUnpairedSurrogate(candidate)
      ) {
        throw providerValidationError(
          'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
          'OpenAI transcription usage metadata contains invalid characters',
        );
      }
      continue;
    }
    if (Array.isArray(candidate)) {
      pending.push(...candidate);
      continue;
    }
    if (isRecord(candidate)) {
      for (const [key, entry] of Object.entries(candidate)) {
        pending.push(key, entry);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countWords(value: string) {
  return value.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function containsUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function providerValidationError(code: string, message: string) {
  return new TrainingOpenAiRequestError(
    code,
    false,
    false,
    null,
    null,
    0,
    message,
  );
}

function isRetryableStorageReadError(error: unknown) {
  if (error instanceof TrainingAudioError) return error.retryable;
  if (error instanceof TypeError) return true;
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return true;
  }
  const message =
    error instanceof Error ? error.message : String(error ?? '');
  if (
    /manual review|TRAINING_AUDIO_BUCKET|privacy|:\s*(?:400|401|403|404)\b/iu.test(
      message,
    )
  ) {
    return false;
  }
  const status =
    typeof (error as { getStatus?: unknown })?.getStatus === 'function'
      ? (error as { getStatus(): unknown }).getStatus()
      : null;
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  ) {
    return false;
  }
  return true;
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
