export type TrainingOpenAIUsage = {
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type TrainingOpenAIUsageLogInput = {
  operation: string;
  model: string;
  reasoningEffort: string | null;
  projectId: string | null;
  questionId?: string | null;
  attemptId?: string | null;
  responseId: string | null;
  usage: TrainingOpenAIUsage | null;
  durationMs: number;
};

export type TrainingOpenAIResponseMetadata = {
  model: string | null;
  responseId: string | null;
  usage: TrainingOpenAIUsage | null;
};

export function parseTrainingOpenAIUsage(value: unknown): TrainingOpenAIUsage | null {
  if (!isRecord(value)) return null;
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : null;
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : null;
  const usage = {
    inputTokens: readTokenCount(value.input_tokens),
    cachedTokens: readTokenCount(inputDetails?.cached_tokens),
    cacheWriteTokens: readTokenCount(inputDetails?.cache_write_tokens),
    outputTokens: readTokenCount(value.output_tokens),
    reasoningTokens: readTokenCount(outputDetails?.reasoning_tokens),
    totalTokens: readTokenCount(value.total_tokens),
  };

  return Object.values(usage).some((count) => count !== null) ? usage : null;
}

export function createTrainingOpenAIUsageLog(input: TrainingOpenAIUsageLogInput) {
  return {
    event: 'training_openai_usage',
    operation: input.operation,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    projectId: input.projectId,
    questionId: input.questionId ?? null,
    attemptId: input.attemptId ?? null,
    responseId: input.responseId,
    inputTokens: input.usage?.inputTokens ?? null,
    cachedTokens: input.usage?.cachedTokens ?? null,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    reasoningTokens: input.usage?.reasoningTokens ?? null,
    totalTokens: input.usage?.totalTokens ?? null,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
  };
}

export async function readTrainingOpenAIResponseMetadata(
  response: Response,
): Promise<TrainingOpenAIResponseMetadata> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { model: null, responseId: null, usage: null };
  }
  return {
    model: isRecord(value) && typeof value.model === 'string' && value.model.trim()
      ? value.model.slice(0, 120)
      : null,
    responseId: readTrainingOpenAIResponseId(value),
    usage: isRecord(value) ? parseTrainingOpenAIUsage(value.usage) : null,
  };
}

export function readTrainingOpenAIResponseId(value: unknown) {
  return isRecord(value) && typeof value.id === 'string' && value.id.length <= 160
    ? value.id
    : null;
}

function readTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
