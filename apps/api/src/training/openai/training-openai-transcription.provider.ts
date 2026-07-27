import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { FilesService } from '../../files/files.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TrainingTranscriptionInput,
  TrainingTranscriptionProvider,
} from '../training-attempt.providers';
import { TrainingOpenAiConfig } from './training-openai.config';
import {
  TrainingOpenAiHttpClient,
  TrainingOpenAiRequestError,
} from './training-openai.http';

const WAV_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
]);
const MAX_TRANSCRIPT_CHARACTERS = 120_000;

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

    const buffer = await this.files.readStoredFile(storedFile);
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
    const vocabularyPrompt = buildVocabularyPrompt(input.approvedVocabulary);
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
        try {
          const candidate = parseJsonObject(
            bodyText,
            'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
          );
          readRequiredString(candidate, 'text');
        } catch (error) {
          throw asRetryableUpstreamResponseError(error);
        }
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
      transcript.length > MAX_TRANSCRIPT_CHARACTERS ||
      containsUnpairedSurrogate(transcript)
    ) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_TEXT_INVALID',
        'OpenAI transcription text is too long or is not valid Unicode',
      );
    }
    if ([...transcript].length < 2) {
      throw providerValidationError(
        'OPENAI_TRANSCRIPTION_TOO_SHORT',
        'OpenAI transcription text is suspiciously short',
      );
    }

    return {
      transcript,
      language:
        typeof payload.language === 'string' && payload.language.trim()
          ? payload.language.trim().toLowerCase()
          : 'ru',
      provider: 'openai',
      requestedModelId,
      actualModelId:
        typeof payload.model === 'string' && payload.model.trim()
          ? payload.model.trim()
          : null,
      requestId: response.requestId,
      wordCount: countWords(transcript),
      usage: isRecord(payload.usage) ? payload.usage : undefined,
      latencyMs: response.latencyMs,
      retryCount: response.retryCount,
      responseStatus: 'completed',
    };
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

function buildVocabularyPrompt(
  vocabulary: TrainingTranscriptionInput['approvedVocabulary'],
) {
  if (!vocabulary) return '';
  const terms = vocabulary.terms
    .map((term) => term.trim().replace(/\s+/gu, ' '))
    .filter((term) => term.length > 0 && term.length <= 120)
    .slice(0, 100);
  if (terms.length === 0) return '';
  return `Утвержденные термины и названия: ${terms.join(', ')}`.slice(0, 2_000);
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

function asRetryableUpstreamResponseError(error: unknown) {
  if (error instanceof TrainingOpenAiRequestError) {
    return new TrainingOpenAiRequestError(
      error.code,
      true,
      false,
      error.status,
      error.requestId,
      error.retryCount,
      error.message,
    );
  }
  return new TrainingOpenAiRequestError(
    'OPENAI_TRANSCRIPTION_RESPONSE_INVALID',
    true,
    false,
    null,
    null,
    0,
    'OpenAI transcription response is temporarily invalid',
  );
}
