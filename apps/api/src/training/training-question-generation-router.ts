import { randomUUID } from 'node:crypto';

import {
  TrainingOpenAIClient,
  TrainingOpenAIError,
  waitBeforeTrainingOpenAIRetry,
} from './training-openai-client';
import {
  readTrainingOpenAIResponseMetadata,
  type TrainingOpenAIUsage,
} from './training-openai-usage';

export const DEFAULT_OPENAI_QUESTION_GENERATION_MODEL = 'gpt-5.6-terra';
export const DEFAULT_OPENAI_QUESTION_GENERATION_LUNA_MODEL = 'gpt-5.6-luna';
export const DEFAULT_TRAINING_QUESTION_GENERATION_STRATEGY = 'terra_only';
export const TRAINING_QUESTION_ROUTING_STRATEGY_VERSION = 'luna-terra-router-v1';
export const TRAINING_QUESTION_VALIDATOR_VERSION = 'training-question-validator-v1';
export const TRAINING_QUESTION_GENERATION_MAX_HTTP_ATTEMPTS = 2;

export type TrainingQuestionGenerationStrategy = 'terra_only' | 'luna_then_terra';

export type TrainingQuestionGenerationRoutingConfig = Readonly<{
  strategy: TrainingQuestionGenerationStrategy;
  routingVersion: typeof TRAINING_QUESTION_ROUTING_STRATEGY_VERSION;
  validatorVersion: typeof TRAINING_QUESTION_VALIDATOR_VERSION;
  primaryModel: string;
  fallbackModel: string | null;
  terraModel: string;
  lunaModel: string;
}>;

export type TrainingQuestionGenerationFallbackReason =
  | 'luna_local_validation_failed'
  | null;

export type TrainingQuestionGenerationAttemptTelemetry = Readonly<{
  attempt: number;
  requestedModel: string;
  actualModel: string | null;
  clientRequestId: string;
  requestId: string | null;
  responseId: string | null;
  httpStatus: number | null;
  outcome: 'accepted' | 'local_validation_failed' | 'transport_error' | 'provider_error';
  errorCode: string | null;
  usage: TrainingOpenAIUsage | null;
  latencyMs: number;
  fallbackReason: TrainingQuestionGenerationFallbackReason;
  finalModel: string | null;
}>;

export type TrainingQuestionGenerationRouteResult<T> = Readonly<{
  value: T;
  finalModel: string;
  requestIds: string[];
  attempts: number;
  telemetry: TrainingQuestionGenerationAttemptTelemetry[];
}>;

type RouteAttempt<T> = {
  value: T;
  model: string;
  telemetry: Omit<TrainingQuestionGenerationAttemptTelemetry, 'finalModel'>;
};

export function readQuestionGenerationRoutingConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): TrainingQuestionGenerationRoutingConfig {
  const strategy = readQuestionGenerationStrategy(environment);
  const terraModel = readExactModel(
    environment,
    'OPENAI_QUESTION_GENERATION_MODEL',
    DEFAULT_OPENAI_QUESTION_GENERATION_MODEL,
  );
  const lunaModel = readExactModel(
    environment,
    'OPENAI_QUESTION_GENERATION_LUNA_MODEL',
    DEFAULT_OPENAI_QUESTION_GENERATION_LUNA_MODEL,
  );

  return {
    strategy,
    routingVersion: TRAINING_QUESTION_ROUTING_STRATEGY_VERSION,
    validatorVersion: TRAINING_QUESTION_VALIDATOR_VERSION,
    primaryModel: strategy === 'terra_only' ? terraModel : lunaModel,
    fallbackModel: strategy === 'terra_only' ? null : terraModel,
    terraModel,
    lunaModel,
  };
}

export function readQuestionGenerationStrategy(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): TrainingQuestionGenerationStrategy {
  const raw = (
    environment.OPENAI_QUESTION_GENERATION_STRATEGY ??
    DEFAULT_TRAINING_QUESTION_GENERATION_STRATEGY
  ).trim();

  if (raw !== 'terra_only' && raw !== 'luna_then_terra') {
    throw new TrainingOpenAIError('OPENAI_QUESTION_GENERATION_STRATEGY_INVALID', false);
  }
  return raw;
}

export async function routeTrainingQuestionGeneration<T>(input: {
  client: TrainingOpenAIClient;
  config: TrainingQuestionGenerationRoutingConfig;
  timeoutMs: number;
  createBody: (model: string) => BodyInit;
  parse: (response: Response) => Promise<T>;
  observeAttempts?: (
    telemetry: readonly TrainingQuestionGenerationAttemptTelemetry[],
  ) => Promise<void> | void;
}): Promise<TrainingQuestionGenerationRouteResult<T>> {
  const deadline = Date.now() + input.timeoutMs;
  const attempts: Array<Omit<TrainingQuestionGenerationAttemptTelemetry, 'finalModel'>> = [];
  let requestedModel = input.config.primaryModel;
  let fallbackReason: TrainingQuestionGenerationFallbackReason = null;

  try {
    while (attempts.length < TRAINING_QUESTION_GENERATION_MAX_HTTP_ATTEMPTS) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new TrainingOpenAIError('OPENAI_TIMEOUT', false, attempts.length);
      }

      const routed = await executeAttempt({
        client: input.client,
        model: requestedModel,
        ordinal: attempts.length + 1,
        timeoutMs: remainingMs,
        body: input.createBody(requestedModel),
        parse: input.parse,
        fallbackReason,
      }).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      if (routed.ok) {
        attempts.push(routed.result.telemetry);
        const finalModel = routed.result.model;
        const telemetry = finalizeTelemetry(attempts, finalModel);
        await safelyObserve(input.observeAttempts, telemetry);
        return {
          value: routed.result.value,
          finalModel,
          requestIds: telemetry.flatMap((attempt) =>
            attempt.requestId ? [attempt.requestId] : [],
          ),
          attempts: telemetry.length,
          telemetry,
        };
      }

      const attachedTelemetry = readAttachedTelemetry(routed.error);
      if (attachedTelemetry) attempts.push(attachedTelemetry);
      const error = normalizeAttemptError(routed.error, attempts.length);
      const latest = attempts.at(-1);
      const lunaValidationFallback =
        input.config.strategy === 'luna_then_terra' &&
        requestedModel === input.config.lunaModel &&
        latest?.outcome === 'local_validation_failed' &&
        input.config.fallbackModel !== null &&
        attempts.length < TRAINING_QUESTION_GENERATION_MAX_HTTP_ATTEMPTS;

      if (lunaValidationFallback) {
        requestedModel = input.config.fallbackModel as string;
        fallbackReason = 'luna_local_validation_failed';
        continue;
      }

      const retrySameModel =
        error.retryable &&
        latest?.outcome === 'transport_error' &&
        attempts.length < TRAINING_QUESTION_GENERATION_MAX_HTTP_ATTEMPTS;
      const terraCompatibilityRetry =
        input.config.strategy === 'terra_only' &&
        error.retryable &&
        attempts.length < TRAINING_QUESTION_GENERATION_MAX_HTTP_ATTEMPTS;

      if (retrySameModel || terraCompatibilityRetry) {
        await waitBeforeTrainingOpenAIRetry(
          readAttachedRetryAfter(routed.error),
          deadline,
          attempts.length,
        );
        continue;
      }
      throw new TrainingOpenAIError(
        error.code,
        error.retryable,
        attempts.length,
        error.detailCode,
      );
    }

    throw new TrainingOpenAIError(
      'OPENAI_RETRIES_EXHAUSTED',
      true,
      attempts.length,
    );
  } catch (error) {
    await safelyObserve(input.observeAttempts, finalizeTelemetry(attempts, null));
    throw error;
  }
}

async function executeAttempt<T>(input: {
  client: TrainingOpenAIClient;
  model: string;
  ordinal: number;
  timeoutMs: number;
  body: BodyInit;
  parse: (response: Response) => Promise<T>;
  fallbackReason: TrainingQuestionGenerationFallbackReason;
}): Promise<RouteAttempt<T>> {
  const startedAt = Date.now();
  const clientRequestId = randomUUID();
  let requestId: string | null = null;
  let responseId: string | null = null;
  let actualModel: string | null = null;
  let usage: TrainingOpenAIUsage | null = null;
  let httpStatus: number | null = null;
  let retryAfter: string | null = null;

  try {
    const response = await input.client.request({
      path: '/responses',
      body: input.body,
      contentType: 'application/json',
      clientRequestId,
      policy: { timeoutMs: input.timeoutMs, maxRetries: 0 },
      parse: input.parse,
      observeResponse: async (observation) => {
        requestId = observation.requestId;
        httpStatus = observation.response.status;
        const retryAfterHeader = observation.response.headers.get('retry-after');
        retryAfter = retryAfterHeader && retryAfterHeader.length <= 120
          ? retryAfterHeader
          : null;
        const metadata = await readTrainingOpenAIResponseMetadata(observation.response);
        responseId = metadata.responseId;
        actualModel = metadata.model;
        usage = metadata.usage;
      },
    });
    requestId ??= response.requestId;
    return {
      value: response.value,
      model: actualModel ?? input.model,
      telemetry: {
        attempt: input.ordinal,
        requestedModel: input.model,
        actualModel,
        clientRequestId,
        requestId,
        responseId,
        httpStatus,
        outcome: 'accepted',
        errorCode: null,
        usage,
        latencyMs: Math.max(0, Date.now() - startedAt),
        fallbackReason: input.fallbackReason,
      },
    };
  } catch (error) {
    const normalized = normalizeAttemptError(error, 1);
    const localValidation =
      httpStatus !== null &&
      httpStatus >= 200 &&
      httpStatus < 300 &&
      isLocalQuestionValidationError(normalized);
    const transportError = isTransportError(normalized);
    const telemetry = {
      attempt: input.ordinal,
      requestedModel: input.model,
      actualModel,
      clientRequestId,
      requestId,
      responseId,
      httpStatus,
      outcome: localValidation
        ? 'local_validation_failed' as const
        : transportError
          ? 'transport_error' as const
          : 'provider_error' as const,
      errorCode: normalized.code,
      usage,
      latencyMs: Math.max(0, Date.now() - startedAt),
      fallbackReason: input.fallbackReason,
    };
    throw Object.assign(normalized, {
      questionGenerationTelemetry: telemetry,
      questionGenerationRetryAfter: retryAfter,
    });
  }
}

function normalizeAttemptError(error: unknown, attempts: number) {
  if (error instanceof TrainingOpenAIError) {
    const telemetry = readAttachedTelemetry(error);
    if (telemetry) return Object.assign(error, { questionGenerationTelemetry: telemetry });
    return error;
  }
  return new TrainingOpenAIError('OPENAI_NETWORK_ERROR', true, attempts);
}

function readAttachedTelemetry(error: unknown) {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('questionGenerationTelemetry' in error)
  ) {
    return null;
  }
  return (error as { questionGenerationTelemetry: Omit<
    TrainingQuestionGenerationAttemptTelemetry,
    'finalModel'
  > }).questionGenerationTelemetry;
}

function readAttachedRetryAfter(error: unknown) {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('questionGenerationRetryAfter' in error)
  ) {
    return null;
  }
  const value = (error as { questionGenerationRetryAfter: unknown })
    .questionGenerationRetryAfter;
  return typeof value === 'string' ? value : null;
}

function isLocalQuestionValidationError(error: TrainingOpenAIError) {
  return error.code === 'OBJECT_QUESTION_DRAFTS_INVALID' ||
    error.code === 'OBJECT_QUESTION_DRAFTS_MALFORMED' ||
    error.code === 'OPENAI_MALFORMED_RESPONSE';
}

function isTransportError(error: TrainingOpenAIError) {
  return error.code === 'OPENAI_TIMEOUT' ||
    error.code === 'OPENAI_NETWORK_ERROR' ||
    error.code === 'OPENAI_RATE_LIMITED' ||
    error.code === 'OPENAI_UPSTREAM_UNAVAILABLE';
}

function finalizeTelemetry(
  attempts: Array<Omit<TrainingQuestionGenerationAttemptTelemetry, 'finalModel'>>,
  finalModel: string | null,
) {
  return attempts.map((attempt) => ({ ...attempt, finalModel }));
}

async function safelyObserve(
  observer: ((
    telemetry: readonly TrainingQuestionGenerationAttemptTelemetry[],
  ) => Promise<void> | void) | undefined,
  telemetry: readonly TrainingQuestionGenerationAttemptTelemetry[],
) {
  if (!observer) return;
  await Promise.resolve(observer(telemetry)).catch(() => undefined);
}

function readExactModel(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: 'OPENAI_QUESTION_GENERATION_MODEL' | 'OPENAI_QUESTION_GENERATION_LUNA_MODEL',
  expected: string,
) {
  const value = (environment[key] ?? expected).trim();
  if (value !== expected) throw new TrainingOpenAIError(`${key}_INVALID`, false);
  return value;
}
