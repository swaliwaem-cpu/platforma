import { formatAssistantUsd, parseAssistantUsd } from './assistant-ai-cost';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type AssistantPaidProviderReadiness = {
  passed: boolean;
  missing: string[];
  effective: {
    aiMode: 'fake' | 'openai' | null;
    requestsPerMinute: number | null;
    requestsPerDay: number | null;
    dailyBudgetUsd: string | null;
    queryPlannerLive: boolean;
    paidCallsConfirmed: boolean;
    apiKeyPresent: boolean;
  };
};

export function readAssistantPaidProviderReadiness(
  environment: AssistantEnvironment = process.env,
): AssistantPaidProviderReadiness {
  const missing: string[] = [];
  const aiMode = readAiMode(environment.ASSISTANT_AI_MODE);
  if (aiMode === null) missing.push('ASSISTANT_AI_MODE');

  const requestsPerMinute = readPositiveInteger(environment.ASSISTANT_MODEL_REQUESTS_PER_MINUTE);
  if (requestsPerMinute === null) missing.push('ASSISTANT_MODEL_REQUESTS_PER_MINUTE');
  const requestsPerDay = readPositiveInteger(environment.ASSISTANT_MODEL_REQUESTS_PER_DAY);
  if (requestsPerDay === null) missing.push('ASSISTANT_MODEL_REQUESTS_PER_DAY');

  const openAi = aiMode === 'openai';
  const dailyBudgetUsd = openAi
    ? readPositiveUsd(environment.ASSISTANT_MODEL_DAILY_BUDGET_USD)
    : null;
  const queryPlannerLive = environment.ASSISTANT_QUERY_PLANNER_LIVE === 'true';
  const paidCallsConfirmed = environment.ASSISTANT_PAID_CALLS_CONFIRMED === 'true';
  const apiKeyPresent = typeof environment.OPENAI_API_KEY === 'string'
    && environment.OPENAI_API_KEY.trim().length > 0;

  if (openAi && dailyBudgetUsd === null) missing.push('ASSISTANT_MODEL_DAILY_BUDGET_USD');
  if (openAi && !queryPlannerLive) missing.push('ASSISTANT_QUERY_PLANNER_LIVE');
  if (openAi && !paidCallsConfirmed) missing.push('ASSISTANT_PAID_CALLS_CONFIRMED');
  if (openAi && !apiKeyPresent) missing.push('OPENAI_API_KEY');

  return {
    passed: missing.length === 0,
    missing,
    effective: {
      aiMode,
      requestsPerMinute,
      requestsPerDay,
      dailyBudgetUsd,
      queryPlannerLive,
      paidCallsConfirmed,
      apiKeyPresent,
    },
  };
}

function readAiMode(value: string | undefined) {
  const normalized = (value ?? 'fake').trim().toLocaleLowerCase('en-US');
  return normalized === 'fake' || normalized === 'openai' ? normalized : null;
}

function readPositiveInteger(value: string | undefined) {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readPositiveUsd(value: string | undefined) {
  if (value === undefined || value.trim() === '') return null;
  try {
    const parsed = parseAssistantUsd(value.trim());
    return parsed > 0n ? formatAssistantUsd(parsed) : null;
  } catch {
    return null;
  }
}
