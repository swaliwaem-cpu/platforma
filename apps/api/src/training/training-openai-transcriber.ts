import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

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
} from './training-transcriber';
import {
  createTrainingOpenAIUsageLog,
  parseTrainingOpenAIUsage,
  readTrainingOpenAIResponseId,
  readTrainingOpenAIResponseMetadata,
} from './training-openai-usage';
import type { TrainingAiUsageRecorder } from './training-ai-usage.service';

const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

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
    if (
      input.sizeBytes !== input.wav.length ||
      input.sizeBytes <= 44 ||
      input.sizeBytes > OPENAI_TRANSCRIPTION_MAX_BYTES ||
      input.wav.toString('ascii', 0, 4) !== 'RIFF' ||
      input.wav.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new TrainingOpenAIError('OPENAI_INVALID_AUDIO', false);
    }

    const model = (
      process.env.OPENAI_TRANSCRIPTION_MODEL ?? DEFAULT_OPENAI_TRANSCRIPTION_MODEL
    ).trim();

    if (!model) throw new TrainingOpenAIError('OPENAI_TRANSCRIPTION_MODEL_INVALID', false);

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(input.wav)], { type: input.mimeType }), 'answer.wav');
    form.set('model', model);
    form.set('language', 'ru');
    form.set('response_format', 'json');
    if (input.vocabularyPrompt) form.set('prompt', input.vocabularyPrompt);

    const operationRunId = randomUUID();
    const response = await this.client.request({
      path: '/audio/transcriptions',
      body: form,
      clientRequestId: operationRunId,
      signal: options?.signal,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
