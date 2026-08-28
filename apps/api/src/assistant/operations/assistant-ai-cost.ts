export const ASSISTANT_AI_PRICING_CATALOG_VERSION = 'openai-standard-pricing-2026-08-27';
export const ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION = 'openai-embedding-pricing-2026-08-28';
export const ASSISTANT_AI_SERVICE_TIER = 'default';

const usdScale = 100_000_000n;
const longContextThreshold = 272_000;
const webSearchCallUsdUnits = 1_000_000n;

type AssistantAiPricingTier = 'standard' | 'long';

type AssistantAiRates = {
  input: bigint;
  cachedInput: bigint;
  cacheWriteInput: bigint;
  output: bigint;
};

const pricingCatalog: Record<string, Record<AssistantAiPricingTier, AssistantAiRates>> = {
  'gpt-5.6-luna': {
    standard: { input: 20n, cachedInput: 2n, cacheWriteInput: 25n, output: 120n },
    long: { input: 40n, cachedInput: 4n, cacheWriteInput: 50n, output: 180n },
  },
  'gpt-5.6-terra': {
    standard: { input: 200n, cachedInput: 20n, cacheWriteInput: 250n, output: 1_200n },
    long: { input: 400n, cachedInput: 40n, cacheWriteInput: 500n, output: 1_800n },
  },
};

const embeddingPricingCatalog: Record<string, { maximumDimensions: number; input: bigint }> = {
  'text-embedding-3-small': { maximumDimensions: 1_536, input: 2n },
  'text-embedding-3-large': { maximumDimensions: 3_072, input: 13n },
};

export type AssistantAiCostInput = {
  model: string;
  serviceTier?: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  webSearchCalls: number | null;
  pricingTier?: AssistantAiPricingTier;
};

export type AssistantAiCostResult = {
  catalogVersion: typeof ASSISTANT_AI_PRICING_CATALOG_VERSION;
  status: 'PRICED' | 'MODEL_UNPRICED' | 'SERVICE_TIER_UNPRICED' | 'USAGE_INCOMPLETE' | 'USAGE_INVALID';
  estimatedUsd: string | null;
  estimatedUsdUnits: bigint | null;
};

export type AssistantEmbeddingCostResult = Omit<AssistantAiCostResult, 'catalogVersion' | 'status'> & {
  catalogVersion: typeof ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION;
  status: AssistantAiCostResult['status'] | 'DIMENSIONS_UNSUPPORTED';
};

export function calculateAssistantAiCost(input: AssistantAiCostInput): AssistantAiCostResult {
  if ((input.serviceTier ?? ASSISTANT_AI_SERVICE_TIER) !== ASSISTANT_AI_SERVICE_TIER) {
    return unpriced('SERVICE_TIER_UNPRICED');
  }
  const tiers = pricingCatalog[input.model];
  if (!tiers) return unpriced('MODEL_UNPRICED');
  const counts = [
    input.inputTokens,
    input.cachedInputTokens,
    input.cacheWriteInputTokens,
    input.outputTokens,
    input.webSearchCalls,
  ];
  if (counts.some((value) => value === null)) return unpriced('USAGE_INCOMPLETE');
  if (counts.some((value) => !isTokenCount(value))) return unpriced('USAGE_INVALID');

  const inputTokens = input.inputTokens!;
  const cachedInputTokens = input.cachedInputTokens!;
  const cacheWriteInputTokens = input.cacheWriteInputTokens!;
  if (cachedInputTokens + cacheWriteInputTokens > inputTokens) {
    return unpriced('USAGE_INVALID');
  }

  const tier = input.pricingTier
    ?? (inputTokens > longContextThreshold ? 'long' : 'standard');
  const rates = tiers[tier];
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;
  const estimatedUsdUnits = BigInt(uncachedInputTokens) * rates.input
    + BigInt(cachedInputTokens) * rates.cachedInput
    + BigInt(cacheWriteInputTokens) * rates.cacheWriteInput
    + BigInt(input.outputTokens!) * rates.output
    + BigInt(input.webSearchCalls!) * webSearchCallUsdUnits;

  return {
    catalogVersion: ASSISTANT_AI_PRICING_CATALOG_VERSION,
    status: 'PRICED',
    estimatedUsd: formatAssistantUsd(estimatedUsdUnits),
    estimatedUsdUnits,
  };
}

export function estimateAssistantAiCallCost(input: {
  model: string;
  serviceTier?: string;
  requestBytes: number;
  maxOutputTokens: number;
  maxWebSearchCalls: number;
}) {
  const requestTokensUpperBound = Math.max(1, Math.trunc(input.requestBytes)) + 4_096;
  const searchContextTokensUpperBound = Math.max(0, Math.trunc(input.maxWebSearchCalls)) * 20_000;
  return calculateAssistantAiCost({
    model: input.model,
    serviceTier: input.serviceTier,
    inputTokens: requestTokensUpperBound + searchContextTokensUpperBound,
    cachedInputTokens: 0,
    cacheWriteInputTokens: requestTokensUpperBound + searchContextTokensUpperBound,
    outputTokens: Math.max(0, Math.trunc(input.maxOutputTokens)),
    webSearchCalls: Math.max(0, Math.trunc(input.maxWebSearchCalls)),
  });
}

export function calculateAssistantEmbeddingCost(input: {
  model: string;
  inputTokens: number | null;
  serviceTier?: string;
}): AssistantEmbeddingCostResult {
  if ((input.serviceTier ?? ASSISTANT_AI_SERVICE_TIER) !== ASSISTANT_AI_SERVICE_TIER) {
    return unpricedEmbedding('SERVICE_TIER_UNPRICED');
  }
  const pricing = embeddingPricingCatalog[input.model];
  if (!pricing) return unpricedEmbedding('MODEL_UNPRICED');
  if (input.inputTokens === null) return unpricedEmbedding('USAGE_INCOMPLETE');
  if (!isTokenCount(input.inputTokens)) return unpricedEmbedding('USAGE_INVALID');
  const estimatedUsdUnits = BigInt(input.inputTokens) * pricing.input;
  return {
    catalogVersion: ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION,
    status: 'PRICED',
    estimatedUsd: formatAssistantUsd(estimatedUsdUnits),
    estimatedUsdUnits,
  };
}

export function estimateAssistantEmbeddingCallCost(input: {
  model: string;
  dimensions: number;
  inputBytes: number;
  serviceTier?: string;
}): AssistantEmbeddingCostResult {
  const pricing = embeddingPricingCatalog[input.model];
  if (!pricing) return unpricedEmbedding('MODEL_UNPRICED');
  if (!Number.isSafeInteger(input.dimensions)
    || input.dimensions < 1
    || input.dimensions > pricing.maximumDimensions) {
    return unpricedEmbedding('DIMENSIONS_UNSUPPORTED');
  }
  if (!Number.isSafeInteger(input.inputBytes) || input.inputBytes < 0) {
    return unpricedEmbedding('USAGE_INVALID');
  }
  return calculateAssistantEmbeddingCost({
    model: input.model,
    inputTokens: input.inputBytes,
    serviceTier: input.serviceTier,
  });
}

export function addAssistantUsd(values: string[]) {
  const total = values.reduce(
    (sum, value) => sum + parseAssistantUsd(value),
    0n,
  );
  return formatAssistantUsd(total);
}

export function parseAssistantUsd(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(value)) {
    throw new Error('ASSISTANT_AI_USD_INVALID');
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * usdScale + BigInt(fraction.padEnd(8, '0'));
}

export function formatAssistantUsd(value: bigint) {
  if (value < 0n) throw new Error('ASSISTANT_AI_USD_INVALID');
  const whole = value / usdScale;
  const fraction = (value % usdScale).toString().padStart(8, '0');
  return `${whole}.${fraction}`;
}

function unpriced(status: Exclude<AssistantAiCostResult['status'], 'PRICED'>): AssistantAiCostResult {
  return {
    catalogVersion: ASSISTANT_AI_PRICING_CATALOG_VERSION,
    status,
    estimatedUsd: null,
    estimatedUsdUnits: null,
  };
}

function unpricedEmbedding(
  status: Exclude<AssistantEmbeddingCostResult['status'], 'PRICED'>,
): AssistantEmbeddingCostResult {
  return {
    catalogVersion: ASSISTANT_EMBEDDING_PRICING_CATALOG_VERSION,
    status,
    estimatedUsd: null,
    estimatedUsdUnits: null,
  };
}

function isTokenCount(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
