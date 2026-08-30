import {
  createEmptyAssistantSearchFilters,
  extractAssistantComparisonTargets,
  extractAssistantExplicitHardFilters,
  type AssistantPlannerGateway,
  type AssistantPlannerGatewayResult,
  type AssistantPlannerRequest,
  type AssistantStructuredIntent,
} from './assistant-query-planner';
import { ASSISTANT_AI_SERVICE_TIER } from './operations/assistant-ai-cost';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type AssistantAiMode = 'fake' | 'openai';

const assistantPlannerSchema = createAssistantPlannerSchema();
export const ASSISTANT_PLANNER_PROMPT_VERSION = 'assistant-query-planner-v1';
const officialKnowledgeFactPattern = /(?:архитектур\p{L}*|инфраструктур\p{L}*|благоустрой\p{L}*|описан\p{L}*|ипотек\p{L}*|ипотеч\p{L}*|рассроч\p{L}*|акци\p{L}*|скидк\p{L}*|бонус\p{L}*|лот\p{L}*\s+\d+)/iu;

export class AssistantPlannerGatewayError extends Error {
  readonly provider = 'openai' as const;

  constructor(
    readonly code: string,
    readonly requestId: string | null = null,
    readonly responseId: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
    this.name = 'AssistantPlannerGatewayError';
  }
}

export function createAssistantPlannerGateway(
  environment: AssistantEnvironment = process.env,
  fetchImplementation: typeof fetch = fetch,
): AssistantPlannerGateway {
  const mode = readAssistantAiMode(environment);
  if (mode === 'fake') return new AssistantFakePlannerGateway();
  if (environment.ASSISTANT_QUERY_PLANNER_LIVE !== 'true') {
    throw new AssistantPlannerGatewayError('ASSISTANT_QUERY_PLANNER_LIVE_REQUIRED');
  }
  if (environment.ASSISTANT_PAID_CALLS_CONFIRMED !== 'true') {
    throw new AssistantPlannerGatewayError('ASSISTANT_PAID_CALLS_CONFIRMATION_REQUIRED');
  }
  const apiKey = environment.OPENAI_API_KEY?.trim() ?? '';
  if (!apiKey) throw new AssistantPlannerGatewayError('OPENAI_API_KEY_MISSING');
  const baseUrl = environment.ASSISTANT_OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const timeoutMs = readAssistantOpenAiTimeoutMs(environment);
  return new AssistantOpenAiPlannerGateway(apiKey, fetchImplementation, baseUrl, timeoutMs);
}

export function readAssistantOpenAiTimeoutMs(environment: AssistantEnvironment = process.env) {
  return readBoundedInteger(environment.ASSISTANT_OPENAI_TIMEOUT_MS, 20_000, 1_000, 120_000);
}

export class AssistantFakePlannerGateway implements AssistantPlannerGateway {
  async plan(request: AssistantPlannerRequest): Promise<AssistantPlannerGatewayResult> {
    return {
      output: createDeterministicIntent(request.messages),
      provider: 'fake',
      httpStatus: 200,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      webSearchCalls: 0,
    };
  }
}

export class AssistantOpenAiPlannerGateway implements AssistantPlannerGateway {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly timeoutMs = 20_000,
  ) {}

  async plan(request: AssistantPlannerRequest): Promise<AssistantPlannerGatewayResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const clientRequestId = createClientRequestId(request);
    try {
      const response = await this.fetchImplementation(`${this.baseUrl.replace(/\/$/u, '')}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
        },
        body: JSON.stringify(createAssistantPlannerRequestBody(request)),
        signal: controller.signal,
      });
      const requestId = readBoundedString(response.headers.get('x-request-id'), 160);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new AssistantPlannerGatewayError('ASSISTANT_OPENAI_TIMEOUT', requestId, null, response.status);
        }
        throw new AssistantPlannerGatewayError('ASSISTANT_OPENAI_MALFORMED_RESPONSE', requestId, null, response.status);
      }
      if (!response.ok) {
        throw new AssistantPlannerGatewayError(`ASSISTANT_OPENAI_HTTP_${response.status}`, requestId, null, response.status);
      }
      if (!isRecord(value)) {
        throw new AssistantPlannerGatewayError('ASSISTANT_OPENAI_MALFORMED_RESPONSE', requestId, null, response.status);
      }
      const outputText = readOutputText(value.output);
      if (!outputText) {
        throw new AssistantPlannerGatewayError(
          'ASSISTANT_OPENAI_OUTPUT_MISSING',
          requestId,
          readBoundedString(value.id, 160),
          response.status,
        );
      }

      let output: unknown;
      try {
        output = JSON.parse(outputText);
      } catch {
        output = null;
      }
      const usage = parseAssistantOpenAiUsage(value);
      return {
        output,
        provider: 'openai',
        requestId,
        responseId: readBoundedString(value.id, 160),
        httpStatus: response.status,
        ...usage,
      };
    } catch (error) {
      if (error instanceof AssistantPlannerGatewayError) throw error;
      throw new AssistantPlannerGatewayError(controller.signal.aborted
        ? 'ASSISTANT_OPENAI_TIMEOUT'
        : 'ASSISTANT_OPENAI_NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createAssistantPlannerSchema() {
  const nullableNumber = { type: ['number', 'null'] };
  const nullableInteger = { type: ['integer', 'null'] };
  const nullableString = { type: ['string', 'null'], minLength: 1, maxLength: 160 };
  const filters = {
    type: 'object',
    additionalProperties: false,
    required: [
      'budgetMinRub',
      'budgetMaxRub',
      'rooms',
      'district',
      'metro',
      'developer',
      'completionYearMin',
      'completionYearMax',
      'completionQuarter',
      'objectType',
      'propertyClass',
      'areaMin',
      'areaMax',
      'floorMin',
      'floorMax',
    ],
    properties: {
      budgetMinRub: { ...nullableNumber, minimum: 0, maximum: 1_000_000_000_000 },
      budgetMaxRub: { ...nullableNumber, minimum: 0, maximum: 1_000_000_000_000 },
      rooms: { type: 'array', maxItems: 11, items: { type: 'integer', minimum: 0, maximum: 10 } },
      district: nullableString,
      metro: nullableString,
      developer: nullableString,
      completionYearMin: { ...nullableInteger, minimum: 1900, maximum: 2200 },
      completionYearMax: { ...nullableInteger, minimum: 1900, maximum: 2200 },
      completionQuarter: { ...nullableInteger, minimum: 1, maximum: 4 },
      objectType: { type: 'string', enum: ['RESIDENTIAL', 'COMMERCIAL'] },
      propertyClass: { ...nullableString, maxLength: 120 },
      areaMin: { ...nullableNumber, minimum: 0, maximum: 100_000 },
      areaMax: { ...nullableNumber, minimum: 0, maximum: 100_000 },
      floorMin: { ...nullableInteger, minimum: -20, maximum: 500 },
      floorMax: { ...nullableInteger, minimum: -20, maximum: 500 },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'taskType',
      'comparisonTargets',
      'hardFilters',
      'softPreferences',
      'requiredFacts',
      'needsClarification',
      'clarificationQuestion',
    ],
    properties: {
      taskType: { type: 'string', enum: ['SEARCH', 'COMPARE', 'FACT', 'LEGAL_TAX'] },
      comparisonTargets: {
        type: 'array',
        maxItems: 2,
        items: { type: 'string', minLength: 1, maxLength: 160 },
      },
      hardFilters: filters,
      softPreferences: filters,
      requiredFacts: {
        type: 'array',
        maxItems: 11,
        items: {
          type: 'string',
          enum: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK', 'ROOMS', 'LOCATION', 'DEVELOPER', 'COMPLETION', 'AREA', 'FLOOR', 'PDF'],
        },
      },
      needsClarification: { type: 'boolean' },
      clarificationQuestion: { type: ['string', 'null'], minLength: 1, maxLength: 300 },
    },
  };
}

export function createAssistantPlannerRequestBody(request: AssistantPlannerRequest) {
  return {
    model: request.model,
    service_tier: ASSISTANT_AI_SERVICE_TIER,
    reasoning: { effort: request.reasoningEffort },
    store: false,
    max_output_tokens: 2_500,
    instructions: [
      `Contract: ${ASSISTANT_PLANNER_PROMPT_VERSION}.`,
      'Ты Query Planner внутренней Platforma по недвижимости.',
      'Преобразуй русскоязычный запрос в строгий structured intent.',
      'Явные условия пользователя всегда являются hard filters. Пожелания без обязательности являются soft preferences.',
      'Не выдумывай названия, цены, наличие, координаты, ссылки или факты: их проверит сервер по базе.',
      'Для налоговых и юридических вопросов выбери LEGAL_TAX. Не давай правовую консультацию.',
      'Для описания проекта, архитектуры, инфраструктуры, благоустройства, ипотеки, рассрочки и акций выбери FACT.',
      'PRICE, AVAILABILITY, FRESHNESS и LINK обязательны для всех задач кроме LEGAL_TAX.',
      'Для явного сравнения двух ЖК или застройщиков заполни comparisonTargets двумя точными названиями.',
      'Если критичных условий поиска не хватает, задай один короткий составной clarificationQuestion.',
    ].join(' '),
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: JSON.stringify({
          trust_boundary: 'UNTRUSTED_USER_TEXT',
          messages: request.messages,
          page_context: request.context,
        }),
      }],
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'platforma_assistant_intent',
        strict: true,
        schema: assistantPlannerSchema,
      },
    },
  };
}

function createDeterministicIntent(messages: string[]): AssistantStructuredIntent {
  const text = messages.join('\n').replace(/ё/giu, 'е');
  const normalized = text.toLocaleLowerCase('ru-RU');
  const hardFilters = {
    ...createEmptyAssistantSearchFilters(),
    ...extractAssistantExplicitHardFilters(messages),
  };

  return {
    taskType: /(?:налог\p{L}*|юрид\p{L}*|договор\p{L}*|закон\p{L}*)/iu.test(normalized)
      ? 'LEGAL_TAX'
      : /сравн\p{L}*/iu.test(normalized)
        ? 'COMPARE'
        : officialKnowledgeFactPattern.test(normalized)
          ? 'FACT'
          : 'SEARCH',
    comparisonTargets: extractAssistantComparisonTargets(messages) ?? [],
    hardFilters,
    softPreferences: createEmptyAssistantSearchFilters(),
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
}

function createClientRequestId(request: AssistantPlannerRequest) {
  const suffix = request.model.endsWith('luna') ? 'luna' : 'terra';
  return `assistant-planner-${suffix}-${Date.now()}`.slice(0, 160);
}

function readOutputText(value: unknown) {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  return null;
}

export function parseAssistantOpenAiUsage(value: unknown) {
  if (!isRecord(value)) {
    return {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      webSearchCalls: null,
    };
  }
  const usage = isRecord(value.usage) ? value.usage : null;
  const inputDetails = usage && isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : null;
  const outputDetails = usage && isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : null;
  return {
    inputTokens: readTokenCount(usage?.input_tokens),
    cachedInputTokens: readTokenCount(inputDetails?.cached_tokens),
    cacheWriteInputTokens: readTokenCount(inputDetails?.cache_write_tokens),
    outputTokens: readTokenCount(usage?.output_tokens),
    reasoningTokens: readTokenCount(outputDetails?.reasoning_tokens),
    totalTokens: readTokenCount(usage?.total_tokens),
    webSearchCalls: Array.isArray(value.output)
      ? value.output.filter((item) => isRecord(item) && item.type === 'web_search_call').length
      : null,
  };
}

function readTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readAssistantAiMode(environment: AssistantEnvironment): AssistantAiMode {
  const mode = (environment.ASSISTANT_AI_MODE ?? 'fake').trim().toLocaleLowerCase('en-US');
  if (mode !== 'fake' && mode !== 'openai') throw new AssistantPlannerGatewayError('ASSISTANT_AI_MODE_INVALID');
  return mode;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AssistantPlannerGatewayError('ASSISTANT_OPENAI_TIMEOUT_MS_INVALID');
  }
  return parsed;
}

function readBoundedString(value: unknown, maximumLength: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
