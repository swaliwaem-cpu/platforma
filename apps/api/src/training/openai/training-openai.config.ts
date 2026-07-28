import { Injectable } from '@nestjs/common';

import { parseTrainingModuleEnabled } from '../training.config';
import {
  allowStagingFakeProviders,
  readTrainingDeploymentEnvironment,
} from '../training-deployment.config';

const MEBIBYTE = 1024 * 1024;
const OPENAI_UPLOAD_LIMIT_BYTES = 25 * MEBIBYTE;
const PLACEHOLDER_KEY_MARKER_PATTERN =
  /(?:change[-_ ]?me|replace|placeholder|your[-_ ]?(?:api[-_ ]?)?key|example|dummy|fake|sample|test[-_ ]?key|todo|insert[-_ ]?key|real[-_ ]?key)/iu;
const REPEATED_KEY_MASK_PATTERN =
  /^(?:[x*#_\-.0]|(?:x|0){4,}|(?:sk[-_])?(?:x|0|test|fake|dummy)[-_]*)+$/iu;

export type TrainingOpenAiProviderMode = 'fake' | 'real';
export type TrainingOpenAiReasoningEffort =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

@Injectable()
export class TrainingOpenAiConfig {
  readonly providerMode: TrainingOpenAiProviderMode;
  readonly apiKey: string | null;
  readonly transcriptionModel: string;
  readonly transcriptionReviewModel: string;
  readonly evaluationModel: string;
  readonly evaluationReasoning: TrainingOpenAiReasoningEffort;
  readonly reviewModel: string;
  readonly reviewReasoning: TrainingOpenAiReasoningEffort;
  readonly transcriptionTimeoutMs: number;
  readonly evaluationTimeoutMs: number;
  readonly transcriptionMaxRetries: number;
  readonly evaluationMaxRetries: number;
  readonly transcriptionMaxBytes: number;
  readonly maxResponseBytes: number;
  readonly evaluationMaxOutputTokens: number;
  readonly smokeEnabled: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
    const deploymentEnvironment =
      readTrainingDeploymentEnvironment(env);
    const trainingEnabled = parseTrainingModuleEnabled(
      env.TRAINING_MODULE_ENABLED,
    );
    const configuredMode = env.OPENAI_PROVIDER_MODE?.trim().toLowerCase();

    if (
      configuredMode !== undefined &&
      configuredMode !== '' &&
      configuredMode !== 'fake' &&
      configuredMode !== 'real'
    ) {
      throw new Error('OPENAI_PROVIDER_MODE must be "fake" or "real"');
    }
    if (nodeEnv === 'test' && configuredMode === 'real') {
      throw new Error('OPENAI_PROVIDER_MODE=real is forbidden in NODE_ENV=test');
    }

    this.providerMode =
      nodeEnv === 'test'
        ? 'fake'
        : ((configuredMode || 'fake') as TrainingOpenAiProviderMode);

    if (
      deploymentEnvironment === 'production' &&
      trainingEnabled &&
      this.providerMode !== 'real'
    ) {
      throw new Error(
        'OPENAI_PROVIDER_MODE=real is required when training is enabled in production',
      );
    }
    if (
      deploymentEnvironment === 'staging' &&
      trainingEnabled &&
      this.providerMode === 'fake' &&
      !allowStagingFakeProviders(env)
    ) {
      throw new Error(
        'STAGING_ALLOW_FAKE_PROVIDERS=true is required for fake OpenAI in staging',
      );
    }
    if (
      deploymentEnvironment === 'production' &&
      allowStagingFakeProviders(env)
    ) {
      throw new Error(
        'STAGING_ALLOW_FAKE_PROVIDERS is forbidden in production',
      );
    }

    this.apiKey =
      this.providerMode === 'real'
        ? readRequiredApiKey(env.OPENAI_API_KEY)
        : null;
    const requireExplicitProductionModels =
      deploymentEnvironment === 'production' &&
      trainingEnabled &&
      this.providerMode === 'real';
    this.transcriptionModel = readModel(
      'OPENAI_TRANSCRIPTION_MODEL',
      env.OPENAI_TRANSCRIPTION_MODEL,
      'gpt-4o-mini-transcribe-2025-12-15',
      requireExplicitProductionModels,
    );
    this.transcriptionReviewModel = readModel(
      'OPENAI_TRANSCRIPTION_REVIEW_MODEL',
      env.OPENAI_TRANSCRIPTION_REVIEW_MODEL,
      'gpt-4o-transcribe',
      requireExplicitProductionModels,
    );
    this.evaluationModel = readModel(
      'OPENAI_EVALUATION_MODEL',
      env.OPENAI_EVALUATION_MODEL,
      'gpt-5.6-terra',
      requireExplicitProductionModels,
    );
    this.evaluationReasoning = readReasoningEffort(
      'OPENAI_EVALUATION_REASONING',
      env.OPENAI_EVALUATION_REASONING,
      'medium',
      requireExplicitProductionModels,
    );
    this.reviewModel = readModel(
      'OPENAI_REVIEW_MODEL',
      env.OPENAI_REVIEW_MODEL,
      'gpt-5.6-terra',
      requireExplicitProductionModels,
    );
    this.reviewReasoning = readReasoningEffort(
      'OPENAI_REVIEW_REASONING',
      env.OPENAI_REVIEW_REASONING,
      'high',
      requireExplicitProductionModels,
    );
    this.transcriptionTimeoutMs = readBoundedInteger(
      'OPENAI_TRANSCRIPTION_TIMEOUT_MS',
      env.OPENAI_TRANSCRIPTION_TIMEOUT_MS,
      60_000,
      1_000,
      300_000,
    );
    this.evaluationTimeoutMs = readBoundedInteger(
      'OPENAI_EVALUATION_TIMEOUT_MS',
      env.OPENAI_EVALUATION_TIMEOUT_MS,
      120_000,
      1_000,
      600_000,
    );
    this.transcriptionMaxRetries = readBoundedInteger(
      'OPENAI_TRANSCRIPTION_MAX_RETRIES',
      env.OPENAI_TRANSCRIPTION_MAX_RETRIES,
      2,
      0,
      5,
    );
    this.evaluationMaxRetries = readBoundedInteger(
      'OPENAI_EVALUATION_MAX_RETRIES',
      env.OPENAI_EVALUATION_MAX_RETRIES,
      2,
      0,
      5,
    );
    this.transcriptionMaxBytes = readBoundedInteger(
      'OPENAI_TRANSCRIPTION_MAX_BYTES',
      env.OPENAI_TRANSCRIPTION_MAX_BYTES,
      24 * MEBIBYTE,
      1,
      OPENAI_UPLOAD_LIMIT_BYTES - 1,
    );
    this.maxResponseBytes = readBoundedInteger(
      'OPENAI_MAX_RESPONSE_BYTES',
      env.OPENAI_MAX_RESPONSE_BYTES,
      2 * MEBIBYTE,
      1_024,
      16 * MEBIBYTE,
    );
    this.evaluationMaxOutputTokens = readBoundedInteger(
      'OPENAI_EVALUATION_MAX_OUTPUT_TOKENS',
      env.OPENAI_EVALUATION_MAX_OUTPUT_TOKENS,
      4_096,
      256,
      32_768,
    );
    this.smokeEnabled = readBoolean(
      'OPENAI_SMOKE_ENABLED',
      env.OPENAI_SMOKE_ENABLED,
      false,
    );
  }
}

function readRequiredApiKey(value: string | undefined) {
  const normalized = value?.trim() ?? '';
  const distinctCharacters = new Set(
    normalized.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, ''),
  ).size;
  if (
    normalized.length < 24 ||
    normalized.length > 512 ||
    /[\s\r\n]/u.test(normalized) ||
    PLACEHOLDER_KEY_MARKER_PATTERN.test(normalized) ||
    REPEATED_KEY_MASK_PATTERN.test(normalized) ||
    distinctCharacters < 8
  ) {
    throw new Error(
      'OPENAI_API_KEY must contain a non-placeholder OpenAI API key in real mode',
    );
  }
  return normalized;
}

function readModel(
  name: string,
  value: string | undefined,
  fallback: string,
  required = false,
) {
  const configured = value?.trim() ?? '';
  if (required && !configured) {
    throw new Error(`${name} is required in production real mode`);
  }
  const normalized = configured || fallback;
  if (normalized.length > 120 || !/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    throw new Error(`${name} must contain a valid model identifier`);
  }
  return normalized;
}

function readReasoningEffort(
  name: string,
  value: string | undefined,
  fallback: TrainingOpenAiReasoningEffort,
  required = false,
): TrainingOpenAiReasoningEffort {
  const configured = value?.trim().toLowerCase() ?? '';
  if (required && !configured) {
    throw new Error(`${name} is required in production real mode`);
  }
  const normalized = (configured ||
    fallback) as TrainingOpenAiReasoningEffort;
  if (
    !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)
  ) {
    throw new Error(
      `${name} must be one of none, low, medium, high, xhigh, max`,
    );
  }
  return normalized;
}

function readBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function readBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
) {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}
