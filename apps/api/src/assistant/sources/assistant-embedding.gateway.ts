import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

const fakeEmbeddingModel = 'assistant-hash-embedding-v1';
const fakeEmbeddingDimensions = 64;
const maximumBatchInputs = 64;
const maximumInputCharacters = 8_000;

type EmbeddingEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class AssistantEmbeddingError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = 'AssistantEmbeddingError';
  }
}

@Injectable()
export class AssistantEmbeddingGateway {
  private readonly mode: 'disabled' | 'fake' | 'openai';
  private readonly model: string | null;
  private readonly dimensions: number | null;
  private readonly timeoutMs: number;

  constructor(
    private readonly environment: EmbeddingEnvironment = process.env,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.mode = readMode(environment.ASSISTANT_EMBEDDING_MODE);
    this.timeoutMs = readInteger(environment.ASSISTANT_EMBEDDING_TIMEOUT_MS, 20_000, 100, 120_000);
    if (this.mode === 'fake') {
      if (environment.DEPLOYMENT_ENV === 'production') {
        throw new AssistantEmbeddingError('ASSISTANT_FAKE_EMBEDDINGS_FORBIDDEN', false);
      }
      this.model = fakeEmbeddingModel;
      this.dimensions = fakeEmbeddingDimensions;
      return;
    }
    if (this.mode === 'openai') {
      this.model = readRequiredString(environment.ASSISTANT_EMBEDDING_MODEL, 'ASSISTANT_EMBEDDING_MODEL_REQUIRED');
      this.dimensions = readInteger(environment.ASSISTANT_EMBEDDING_DIMENSIONS, 0, 1, 4_096);
      if (this.dimensions === 0) {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_DIMENSIONS_REQUIRED', false);
      }
      readRequiredString(environment.OPENAI_API_KEY, 'OPENAI_API_KEY_REQUIRED');
      return;
    }
    this.model = null;
    this.dimensions = null;
  }

  isEnabled() {
    return this.mode !== 'disabled';
  }

  getModel() {
    return this.model;
  }

  async embed(values: string[]): Promise<{ model: string; vectors: number[][] }> {
    const inputs = validateInputs(values);
    if (this.mode === 'disabled' || !this.model || !this.dimensions) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_DISABLED', false);
    }
    if (this.mode === 'fake') {
      return {
        model: this.model,
        vectors: inputs.map((value) => createFakeEmbedding(value)),
      };
    }

    const controller = new AbortController();
    let rejectDeadline!: (error: AssistantEmbeddingError) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectDeadline(new AssistantEmbeddingError('ASSISTANT_EMBEDDING_TIMEOUT', true));
    }, this.timeoutMs);
    timeout.unref();
    try {
      const response = await Promise.race([this.fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.environment.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          dimensions: this.dimensions,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      }), deadline]);
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new AssistantEmbeddingError(
          retryable ? 'ASSISTANT_EMBEDDING_PROVIDER_RETRYABLE' : 'ASSISTANT_EMBEDDING_PROVIDER_REJECTED',
          retryable,
        );
      }
      let payload: unknown;
      try {
        payload = await Promise.race([response.json(), deadline]);
      } catch (error) {
        if (error instanceof AssistantEmbeddingError) throw error;
        if (controller.signal.aborted || isAbortError(error)) {
          throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_TIMEOUT', true);
        }
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_RESPONSE_INVALID', false);
      }
      if (controller.signal.aborted) {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_TIMEOUT', true);
      }
      const vectors = parseEmbeddingResponse(payload, inputs.length, this.dimensions);
      return { model: this.model, vectors };
    } catch (error) {
      if (error instanceof AssistantEmbeddingError) throw error;
      throw new AssistantEmbeddingError(
        controller.signal.aborted || isAbortError(error)
          ? 'ASSISTANT_EMBEDDING_TIMEOUT'
          : 'ASSISTANT_EMBEDDING_PROVIDER_FAILED',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateInputs(values: string[]) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximumBatchInputs) {
    throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_INPUT_INVALID', false);
  }
  return values.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximumInputCharacters) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_INPUT_INVALID', false);
    }
    return value;
  });
}

function parseEmbeddingResponse(value: unknown, expectedCount: number, dimensions: number) {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== expectedCount) {
    throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_RESPONSE_INVALID', false);
  }
  const vectors: Array<number[] | undefined> = Array.from({ length: expectedCount });
  for (const item of value.data) {
    if (!isRecord(item) || !Number.isInteger(item.index) || (item.index as number) < 0
      || (item.index as number) >= expectedCount || vectors[item.index as number]
      || !Array.isArray(item.embedding) || item.embedding.length !== dimensions
      || item.embedding.some((number) => typeof number !== 'number' || !Number.isFinite(number))) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_RESPONSE_INVALID', false);
    }
    vectors[item.index as number] = item.embedding as number[];
  }
  if (vectors.some((vector) => vector === undefined)) {
    throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_RESPONSE_INVALID', false);
  }
  return vectors as number[][];
}

function createFakeEmbedding(value: string) {
  const bytes = createHash('sha512').update(value).digest();
  const vector = Array.from(bytes, (byte) => (byte - 127.5) / 127.5);
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return vector.map((item) => item / magnitude);
}

function readMode(value: string | undefined) {
  const normalized = (value ?? 'disabled').trim().toLocaleLowerCase('en-US');
  if (normalized === 'disabled' || normalized === 'fake' || normalized === 'openai') return normalized;
  throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_MODE_INVALID', false);
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_CONFIG_INVALID', false);
  }
  return parsed;
}

function readRequiredString(value: string | undefined, code: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new AssistantEmbeddingError(code, false);
  }
  return value.trim();
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
