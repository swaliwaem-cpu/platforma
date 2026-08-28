import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  ASSISTANT_AI_SERVICE_TIER,
  estimateAssistantEmbeddingCallCost,
} from '../operations/assistant-ai-cost';
import {
  AssistantAiUsageBudgetService,
  readAssistantDailyUsdBudget,
  type AssistantAiUsageOperation,
  type AssistantAiUsageReservation,
} from '../operations/assistant-ai-usage-budget.service';

const fakeEmbeddingModel = 'assistant-hash-embedding-v1';
const fakeEmbeddingDimensions = 64;
const maximumBatchInputs = 64;
const maximumInputBytes = 8_192;
const maximumAggregateInputBytes = 300_000;
const maximumResponseBytes = 8 * 1_024 * 1_024;
export const assistantEmbeddingBenchmarkDatasetSha256 = '12738976501f102bcf2f8dcc26f54520cc1bee9a5c5af63894bdf998092de018';

type EmbeddingEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type EmbeddingUsageBudgets = Pick<
  AssistantAiUsageBudgetService,
  'reserve' | 'settle' | 'reconcileExpiredReservations'
>;

export type AssistantEmbeddingOperationContext = {
  operation: Extract<AssistantAiUsageOperation, `EMBEDDING_${string}`>;
  operationRunId: string;
  executionId: string;
  nextAttemptOrdinal(): number;
};

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
  private readonly dailyBudgetUsd: string | null;

  constructor(
    private readonly environment: EmbeddingEnvironment = process.env,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly usageBudgets?: EmbeddingUsageBudgets,
  ) {
    this.mode = readMode(environment.ASSISTANT_EMBEDDING_MODE);
    this.timeoutMs = readInteger(environment.ASSISTANT_EMBEDDING_TIMEOUT_MS, 20_000, 100, 120_000);
    if (this.mode === 'fake') {
      if (environment.DEPLOYMENT_ENV === 'production') {
        throw new AssistantEmbeddingError('ASSISTANT_FAKE_EMBEDDINGS_FORBIDDEN', false);
      }
      this.model = fakeEmbeddingModel;
      this.dimensions = fakeEmbeddingDimensions;
      this.dailyBudgetUsd = null;
      return;
    }
    if (this.mode === 'openai') {
      if (environment.ASSISTANT_EMBEDDING_LIVE !== 'true') {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_LIVE_REQUIRED', false);
      }
      if (environment.ASSISTANT_PAID_CALLS_CONFIRMED !== 'true') {
        throw new AssistantEmbeddingError('ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED', false);
      }
      this.model = readRequiredString(environment.ASSISTANT_EMBEDDING_MODEL, 'ASSISTANT_EMBEDDING_MODEL_REQUIRED');
      this.dimensions = readInteger(environment.ASSISTANT_EMBEDDING_DIMENSIONS, 0, 1, 3_072);
      if (this.dimensions === 0) {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_DIMENSIONS_REQUIRED', false);
      }
      const pricing = estimateAssistantEmbeddingCallCost({
        model: this.model,
        dimensions: this.dimensions,
        inputBytes: 1,
      });
      if (pricing.status === 'MODEL_UNPRICED') {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_MODEL_UNPRICED', false);
      }
      if (pricing.status === 'DIMENSIONS_UNSUPPORTED') {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_DIMENSIONS_UNSUPPORTED', false);
      }
      if (pricing.status !== 'PRICED') {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_COST_UNPRICED', false);
      }
      readRequiredString(environment.OPENAI_API_KEY, 'OPENAI_API_KEY_REQUIRED');
      try {
        this.dailyBudgetUsd = readAssistantDailyUsdBudget(
          environment.ASSISTANT_MODEL_DAILY_BUDGET_USD,
          true,
        );
      } catch {
        throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_DAILY_BUDGET_REQUIRED', false);
      }
      if (environment.DEPLOYMENT_ENV === 'production') {
        const expectedWinner = `${this.model}:${this.dimensions}:${assistantEmbeddingBenchmarkDatasetSha256}`;
        if (environment.ASSISTANT_EMBEDDING_BENCHMARK_WINNER !== expectedWinner) {
          throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_BENCHMARK_WINNER_REQUIRED', false);
        }
      }
      return;
    }
    this.model = null;
    this.dimensions = null;
    this.dailyBudgetUsd = null;
  }

  isEnabled() {
    return this.mode !== 'disabled';
  }

  getModel() {
    return this.model;
  }

  getDimensions() {
    return this.dimensions;
  }

  async embed(
    values: string[],
    context?: AssistantEmbeddingOperationContext,
  ): Promise<{ model: string; vectors: number[][] }> {
    const { inputs, inputBytes } = validateInputs(values);
    if (this.mode === 'disabled' || !this.model || !this.dimensions) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_DISABLED', false);
    }
    if (this.mode === 'fake') {
      return {
        model: this.model,
        vectors: inputs.map((value) => createFakeEmbedding(value)),
      };
    }

    if (!context || !this.usageBudgets || !this.dailyBudgetUsd) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_LEDGER_CONTEXT_REQUIRED', false);
    }
    const attemptOrdinal = context.nextAttemptOrdinal();
    if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_ATTEMPT_ORDINAL_INVALID', false);
    }
    const estimated = estimateAssistantEmbeddingCallCost({
      model: this.model,
      dimensions: this.dimensions,
      inputBytes,
    });
    if (estimated.status !== 'PRICED' || estimated.estimatedUsd === null) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_COST_UNPRICED', false);
    }
    let reservation: AssistantAiUsageReservation;
    try {
      reservation = await this.usageBudgets.reserve({
        provider: 'openai',
        model: this.model,
        operation: context.operation,
        operationRunId: context.operationRunId,
        executionId: context.executionId,
        attemptOrdinal,
        dailyBudgetUsd: this.dailyBudgetUsd,
        reservedCostUsd: estimated.estimatedUsd,
        serviceTier: ASSISTANT_AI_SERVICE_TIER,
        validatorVersion: `assistant-embedding-v1:${this.dimensions}`,
        providerTimeoutMs: this.timeoutMs,
      });
    } catch {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_RESERVATION_FAILED', true);
    }

    const startedAt = Date.now();
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
    let responseModel: string | null = null;
    let promptTokens: number | null = null;
    let totalTokens: number | null = null;
    let vectors: number[][] | null = null;
    let failure: AssistantEmbeddingError | null = null;
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
        payload = await readBoundedJson(response, deadline);
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
      const parsed = parseEmbeddingResponse(payload, inputs.length, this.dimensions, this.model);
      responseModel = parsed.model;
      promptTokens = parsed.promptTokens;
      totalTokens = parsed.totalTokens;
      vectors = parsed.vectors;
    } catch (error) {
      failure = error instanceof AssistantEmbeddingError ? error : new AssistantEmbeddingError(
        controller.signal.aborted || isAbortError(error)
          ? 'ASSISTANT_EMBEDDING_TIMEOUT'
          : 'ASSISTANT_EMBEDDING_PROVIDER_FAILED',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    try {
      await this.usageBudgets.settle({
        reservation,
        actualModel: responseModel ?? this.model,
        outcome: failure ? 'PROVIDER_ERROR' : 'ACCEPTED',
        errorCode: failure?.code ?? null,
        inputTokens: failure ? null : promptTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: failure ? null : totalTokens,
        webSearchCalls: 0,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_USAGE_SETTLEMENT_FAILED', true);
    }
    if (failure) throw failure;
    return { model: this.model, vectors: vectors! };
  }

  async reconcileExecution(operationRunId: string, executionId: string) {
    if (this.mode !== 'openai') return 0;
    if (!this.usageBudgets) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_LEDGER_CONTEXT_REQUIRED', false);
    }
    try {
      return await this.usageBudgets.reconcileExpiredReservations({ operationRunId, executionId });
    } catch (error) {
      const retryable = typeof error === 'object' && error !== null
        && (error as { retryAt?: unknown }).retryAt instanceof Date;
      throw new AssistantEmbeddingError(
        retryable ? 'ASSISTANT_EMBEDDING_RESERVATION_ACTIVE' : 'ASSISTANT_EMBEDDING_RECONCILIATION_FAILED',
        retryable,
      );
    }
  }
}

function validateInputs(values: string[]) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximumBatchInputs) {
    throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_INPUT_INVALID', false);
  }
  let inputBytes = 0;
  const inputs = values.map((value) => {
    const byteLength = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
    if (typeof value !== 'string' || !value.trim() || byteLength > maximumInputBytes) {
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_INPUT_INVALID', false);
    }
    inputBytes += byteLength;
    return value;
  });
  if (inputBytes > maximumAggregateInputBytes) {
    throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_INPUT_INVALID', false);
  }
  return { inputs, inputBytes };
}

function parseEmbeddingResponse(
  value: unknown,
  expectedCount: number,
  dimensions: number,
  expectedModel: string,
) {
  if (!isRecord(value)
    || value.model !== expectedModel
    || !isRecord(value.usage)
    || !isTokenCount(value.usage.prompt_tokens)
    || !isTokenCount(value.usage.total_tokens)
    || value.usage.total_tokens < value.usage.prompt_tokens
    || !Array.isArray(value.data)
    || value.data.length !== expectedCount) {
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
  return {
    model: value.model,
    promptTokens: value.usage.prompt_tokens,
    totalTokens: value.usage.total_tokens,
    vectors: vectors as number[][],
  };
}

async function readBoundedJson(response: Response, deadline: Promise<never>) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return Promise.race([response.json(), deadline]);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const part = await Promise.race([reader.read(), deadline]);
    if (part.done) break;
    totalBytes += part.value.byteLength;
    if (totalBytes > maximumResponseBytes) {
      await reader.cancel();
      throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_RESPONSE_TOO_LARGE', false);
    }
    chunks.push(part.value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new AssistantEmbeddingError('ASSISTANT_EMBEDDING_RESPONSE_INVALID', false);
  }
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

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
