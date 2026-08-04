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

const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

export class OpenAITrainingTranscriber implements TrainingTranscriber {
  constructor(private readonly client: TrainingOpenAIClient) {}

  async transcribe(input: TrainingTranscriptionInput): Promise<TrainingTranscriptionResult> {
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

    const response = await this.client.request({
      path: '/audio/transcriptions',
      body: form,
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
          usage: parseUsage(value.usage),
        };
      },
    });

    return {
      text: response.value.text,
      model: response.value.actualModel,
      requestId: response.requestId,
      latencyMs: response.latencyMs,
      attempts: response.attempts,
      usage: response.value.usage,
    };
  }
}

function parseUsage(value: unknown) {
  if (!isRecord(value)) return null;
  const usage: Record<string, number> = {};

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) usage[key] = item;
  }

  return Object.keys(usage).length ? usage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
