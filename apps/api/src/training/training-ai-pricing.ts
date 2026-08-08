import type { TrainingOpenAIUsage } from './training-openai-usage';

type TrainingAiPriceTier = Readonly<{
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number;
}>;

type TrainingAiModelPrice = Readonly<{
  short: TrainingAiPriceTier;
  long: TrainingAiPriceTier;
}>;

type TrainingAiPricingSnapshot = Readonly<{
  version: string;
  effectiveFrom: string;
  shortContextMaximumInputTokens: number;
  models: Readonly<Record<string, TrainingAiModelPrice>>;
}>;

export type TrainingAiCostEstimate = Readonly<{
  pricingVersion: string | null;
  pricingStatus:
    | 'estimated'
    | 'usage_incomplete'
    | 'model_unpriced'
    | 'snapshot_unavailable';
  estimatedCostUsd: string | null;
}>;

// Append a new immutable snapshot when provider prices change. Historical events retain
// both the selected version and the estimate produced with that version.
export const TRAINING_AI_PRICING_SNAPSHOTS: readonly TrainingAiPricingSnapshot[] = [
  {
    version: 'openai-standard-pricing-2026-08-07',
    effectiveFrom: '2026-08-07T00:00:00.000Z',
    shortContextMaximumInputTokens: 272_000,
    models: {
      'gpt-5.6-luna': {
        short: {
          inputUsdPerMillion: 0.2,
          cachedInputUsdPerMillion: 0.02,
          cacheWriteUsdPerMillion: 0.25,
          outputUsdPerMillion: 1.2,
        },
        long: {
          inputUsdPerMillion: 0.4,
          cachedInputUsdPerMillion: 0.04,
          cacheWriteUsdPerMillion: 0.5,
          outputUsdPerMillion: 1.8,
        },
      },
      'gpt-5.6-terra': {
        short: {
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.2,
          cacheWriteUsdPerMillion: 2.5,
          outputUsdPerMillion: 12,
        },
        long: {
          inputUsdPerMillion: 4,
          cachedInputUsdPerMillion: 0.4,
          cacheWriteUsdPerMillion: 5,
          outputUsdPerMillion: 18,
        },
      },
    },
  },
] as const;

export function estimateTrainingAiCost(
  model: string,
  usage: TrainingOpenAIUsage | null,
  occurredAt = new Date(),
): TrainingAiCostEstimate {
  const snapshot = [...TRAINING_AI_PRICING_SNAPSHOTS]
    .reverse()
    .find((candidate) => Date.parse(candidate.effectiveFrom) <= occurredAt.getTime());

  if (!snapshot) {
    return {
      pricingVersion: null,
      pricingStatus: 'snapshot_unavailable',
      estimatedCostUsd: null,
    };
  }

  const modelPrice = snapshot.models[model];
  if (!modelPrice) {
    return {
      pricingVersion: snapshot.version,
      pricingStatus: 'model_unpriced',
      estimatedCostUsd: null,
    };
  }
  if (
    !usage ||
    usage.inputTokens === null ||
    usage.cachedTokens === null ||
    usage.cacheWriteTokens === null ||
    usage.outputTokens === null
  ) {
    return {
      pricingVersion: snapshot.version,
      pricingStatus: 'usage_incomplete',
      estimatedCostUsd: null,
    };
  }

  const tier = usage.inputTokens <= snapshot.shortContextMaximumInputTokens
    ? modelPrice.short
    : modelPrice.long;
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens,
  );
  const cost = (
    uncachedInputTokens * tier.inputUsdPerMillion +
    usage.cachedTokens * tier.cachedInputUsdPerMillion +
    usage.cacheWriteTokens * tier.cacheWriteUsdPerMillion +
    usage.outputTokens * tier.outputUsdPerMillion
  ) / 1_000_000;

  return {
    pricingVersion: snapshot.version,
    pricingStatus: 'estimated',
    estimatedCostUsd: cost.toFixed(8),
  };
}
