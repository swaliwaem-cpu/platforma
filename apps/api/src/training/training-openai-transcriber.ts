import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { Logger } from '@nestjs/common';

import {
  getTrainingAudioLimits,
  OPENAI_TRANSCRIPTION_HARD_MAX_BYTES,
} from './training-audio-limits';
import {
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  readTrainingOpenAIInteger,
  TrainingOpenAIClient,
  TrainingOpenAIError,
} from './training-openai-client';
import type {
  TrainingTranscriber,
  TrainingTranscriptionInput,
  TrainingTranscriptionResult,
  TrainingTranscriptionUpload,
} from './training-transcriber';
import {
  createTrainingOpenAIUsageLog,
  parseTrainingOpenAIUsage,
  readTrainingOpenAIResponseId,
  readTrainingOpenAIResponseMetadata,
  type TrainingOpenAIUsage,
} from './training-openai-usage';
import type { TrainingAiUsageRecorder } from './training-ai-usage.service';

type TranscriptionPartResult = TrainingTranscriptionResult;

export class OpenAITrainingTranscriber implements TrainingTranscriber {
  private readonly logger = new Logger(OpenAITrainingTranscriber.name);

  constructor(
    private readonly client: TrainingOpenAIClient,
    private readonly usageRecorder?: TrainingAiUsageRecorder,
  ) {}

  async transcribe(
    input: TrainingTranscriptionInput,
    options?: { signal?: AbortSignal },
  ): Promise<TrainingTranscriptionResult> {
    const uploads = await resolveTranscriptionUploads(input);
    const model = (
      process.env.OPENAI_TRANSCRIPTION_MODEL ?? DEFAULT_OPENAI_TRANSCRIPTION_MODEL
    ).trim();

    if (!model) throw new TrainingOpenAIError('OPENAI_TRANSCRIPTION_MODEL_INVALID', false);

    const results: TranscriptionPartResult[] = [];
    let attempts = 0;

    for (const upload of uploads) {
      try {
        const prompt = buildChunkPrompt(
          input.vocabularyPrompt,
          results.at(-1)?.text ?? '',
        );
        const result = await this.transcribePart(
          input,
          upload,
          model,
          prompt,
          uploads.length,
          options?.signal,
        );
        attempts += result.attempts;
        results.push(result);
      } catch (error) {
        if (error instanceof TrainingOpenAIError) {
          throw new TrainingOpenAIError(
            error.code,
            error.retryable,
            attempts + error.attempts,
            error.detailCode,
          );
        }
        throw error;
      }
    }

    const last = results.at(-1);
    if (!last) throw new TrainingOpenAIError('OPENAI_INVALID_AUDIO', false);

    return {
      text: mergeTrainingTranscriptChunks(results.map((result) => result.text)),
      model: last.model,
      requestId: last.requestId,
      latencyMs: results.reduce((total, result) => total + result.latencyMs, 0),
      attempts,
      responseId: last.responseId,
      usage: aggregateTrainingOpenAIUsage(results.map((result) => result.usage)),
    };
  }

  private async transcribePart(
    input: TrainingTranscriptionInput,
    upload: ResolvedTranscriptionUpload,
    model: string,
    prompt: string,
    uploadCount: number,
    signal?: AbortSignal,
  ): Promise<TranscriptionPartResult> {
    const form = new FormData();
    const file = upload.filePath
      ? await openAsBlob(upload.filePath, { type: upload.mimeType })
      : new Blob([new Uint8Array(upload.buffer!)], { type: upload.mimeType });
    form.set('file', file, upload.fileName);
    form.set('model', model);
    form.set('language', 'ru');
    form.set('response_format', 'json');
    if (prompt) form.set('prompt', prompt);

    const operationRunId = randomUUID();
    const response = await this.client.request({
      path: '/audio/transcriptions',
      body: form,
      clientRequestId: operationRunId,
      signal,
      policy: {
        timeoutMs: readTrainingOpenAIInteger(
          'OPENAI_TRANSCRIPTION_TIMEOUT_MS',
          60_000,
          1_000,
          300_000,
        ),
        maxRetries: readTrainingOpenAIInteger(
          'OPENAI_TRANSCRIPTION_MAX_RETRIES',
          2,
          0,
          5,
        ),
      },
      parse: async (httpResponse) => {
        const value: unknown = await httpResponse.json();

        if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) {
          throw new TrainingOpenAIError('OPENAI_EMPTY_TRANSCRIPT', true);
        }

        return {
          text: value.text.normalize('NFC').trim(),
          actualModel: typeof value.model === 'string' && value.model.trim()
            ? value.model.slice(0, 120)
            : model,
          responseId: readTrainingOpenAIResponseId(value),
          usage: parseTrainingOpenAIUsage(value.usage),
        };
      },
      observeAttempt: async (observation) => {
        const metadata = observation.response
          ? await readTrainingOpenAIResponseMetadata(observation.response)
          : { model: null, responseId: null, usage: null };
        const usageLog = createTrainingOpenAIUsageLog({
          operation: 'training_audio_transcription',
          model: metadata.model ?? model,
          reasoningEffort: null,
          projectId: input.projectId,
          attemptId: input.attemptId,
          responseId: metadata.responseId,
          usage: metadata.usage,
          durationMs: observation.durationMs,
        });
        this.logger.log({
          ...usageLog,
          operationRunId,
          audioPart: upload.sequence + 1,
          audioParts: uploadCount,
          attempt: observation.attempt,
          requestId: observation.requestId,
          httpStatus: observation.httpStatus,
          outcome: observation.outcome,
          errorCode: observation.errorCode,
        });
        await this.usageRecorder?.record({
          operationRunId,
          operation: usageLog.operation,
          requestedModel: model,
          model: metadata.model ?? model,
          reasoningEffort: null,
          promptVersion: null,
          compilerVersion: null,
          schemaVersion: null,
          projectId: input.projectId,
          attemptId: input.attemptId,
          attemptOrdinal: observation.attempt,
          clientRequestId: observation.clientRequestId,
          requestId: observation.requestId,
          responseId: metadata.responseId,
          httpStatus: observation.httpStatus,
          outcome: observation.outcome,
          errorCode: observation.errorCode,
          isRetry: observation.attempt > 1,
          isFallback: false,
          usage: metadata.usage,
          latencyMs: observation.durationMs,
        });
      },
    });

    return {
      text: response.value.text,
      model: response.value.actualModel,
      requestId: response.requestId,
      latencyMs: response.latencyMs,
      attempts: response.attempts,
      responseId: response.value.responseId,
      usage: response.value.usage,
    };
  }
}

type ResolvedTranscriptionUpload = TrainingTranscriptionUpload & { buffer?: Buffer };

async function resolveTranscriptionUploads(
  input: TrainingTranscriptionInput,
): Promise<ResolvedTranscriptionUpload[]> {
  const configuredMax = getTrainingAudioLimits().providerUploadMaxBytes;
  const maximumBytes = Math.min(configuredMax, OPENAI_TRANSCRIPTION_HARD_MAX_BYTES);
  const uploads: ResolvedTranscriptionUpload[] = input.providerUploads?.length
    ? input.providerUploads
    : input.filePath
      ? [{
          sequence: 0,
          filePath: input.filePath,
          fileName: input.fileName ?? fileNameForMimeType(input.mimeType),
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          checksum: input.checksum,
          startSeconds: 0,
          endSeconds: 0,
        }]
      : input.wav
        ? [{
            sequence: 0,
            filePath: '',
            fileName: fileNameForMimeType(input.mimeType),
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            checksum: input.checksum,
            startSeconds: 0,
            endSeconds: 0,
            buffer: input.wav,
          }]
        : [];

  if (!uploads.length) throw new TrainingOpenAIError('OPENAI_INVALID_AUDIO', false);

  for (const [index, upload] of uploads.entries()) {
    if (
      upload.sequence !== index ||
      !Number.isSafeInteger(upload.sizeBytes) ||
      upload.sizeBytes <= 4 ||
      upload.sizeBytes > maximumBytes ||
      !isSupportedAudioMimeType(upload.mimeType) ||
      !upload.checksum
    ) {
      throw new TrainingOpenAIError('OPENAI_INVALID_AUDIO', false);
    }

    if (upload.filePath) {
      const fileStats = await stat(upload.filePath).catch(() => null);
      if (!fileStats || fileStats.size !== upload.sizeBytes) {
        throw new TrainingOpenAIError('OPENAI_INVALID_AUDIO', false);
      }
      await assertAudioHeader(upload.filePath, upload.mimeType);
    } else if (
      !upload.buffer ||
      upload.buffer.length !== upload.sizeBytes ||
      !hasValidAudioHeader(upload.buffer, upload.mimeType)
    ) {
      throw new TrainingOpenAIError('OPENAI_INVALID_AUDIO', false);
    }
  }

  return uploads;
}

export function mergeTrainingTranscriptChunks(chunks: string[]) {
  const normalized = chunks
    .map((chunk) => chunk.normalize('NFC').trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const first = normalized[0];
  if (!first) return '';

  let merged = first;
  for (const chunk of normalized.slice(1)) {
    const previousWords = merged.split(' ');
    const currentWords = chunk.split(' ');
    const maximumOverlap = Math.min(40, previousWords.length, currentWords.length);
    let overlap = 0;

    for (let length = maximumOverlap; length > 0; length -= 1) {
      const previous = previousWords.slice(-length).join(' ').toLocaleLowerCase('ru-RU');
      const current = currentWords.slice(0, length).join(' ').toLocaleLowerCase('ru-RU');
      if (previous === current) {
        overlap = length;
        break;
      }
    }

    merged = `${merged} ${currentWords.slice(overlap).join(' ')}`.trim();
  }

  return merged;
}

function buildChunkPrompt(vocabularyPrompt: string, previousTranscript: string) {
  const context = previousTranscript
    ? `Конец предыдущей части: ${previousTranscript.slice(-500)}`
    : '';
  if (!context) return vocabularyPrompt.slice(0, 1_500);
  const vocabularyBudget = Math.max(0, 1_500 - context.length - 1);
  return [vocabularyPrompt.slice(0, vocabularyBudget), context]
    .filter(Boolean)
    .join('\n');
}

function aggregateTrainingOpenAIUsage(values: Array<TrainingOpenAIUsage | null>) {
  const present = values.filter((value): value is TrainingOpenAIUsage => value !== null);
  if (!present.length) return null;
  const fields = [
    'inputTokens',
    'cachedTokens',
    'cacheWriteTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
  ] as const;
  return Object.fromEntries(fields.map((field) => {
    const counts = present.map((value) => value[field]).filter((value) => value !== null);
    return [field, counts.length ? counts.reduce((total, value) => total + value, 0) : null];
  })) as TrainingOpenAIUsage;
}

async function assertAudioHeader(filePath: string, mimeType: 'audio/webm' | 'audio/wav') {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!hasValidAudioHeader(header.subarray(0, bytesRead), mimeType)) {
      throw new TrainingOpenAIError('OPENAI_INVALID_AUDIO', false);
    }
  } finally {
    await handle.close();
  }
}

function hasValidAudioHeader(buffer: Buffer, mimeType: 'audio/webm' | 'audio/wav') {
  if (mimeType === 'audio/webm') {
    return buffer.length >= 4 &&
      buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  return buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE';
}

function fileNameForMimeType(mimeType: 'audio/webm' | 'audio/wav') {
  return mimeType === 'audio/webm' ? 'answer.webm' : 'answer.wav';
}

function isSupportedAudioMimeType(value: string): value is 'audio/webm' | 'audio/wav' {
  return value === 'audio/webm' || value === 'audio/wav';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
