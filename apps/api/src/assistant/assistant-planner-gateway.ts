import {
  createEmptyAssistantSearchFilters,
  extractAssistantLogicalPredicates,
  extractAssistantComparisonTargets,
  extractAssistantExplicitHardFilters,
  isAssistantCurrentOfferRequest,
  isAssistantExternalKnowledgeFactRequest,
  isAssistantObjectKnowledgeFactRequest,
  isAssistantObjectCatalogRequest,
  ASSISTANT_CLARIFICATION_QUESTIONS,
  ASSISTANT_TERRA_MODEL,
  type AssistantPlannerGateway,
  type AssistantPlannerGatewayResult,
  type AssistantPlannerRequest,
  type AssistantLogicalPlanV1,
} from './assistant-query-planner';
import { assistantFiltersHaveConflict } from './assistant-plan-grounding';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type AssistantAiMode = 'fake' | 'alibaba';
export type AssistantAlibabaStructuredOutput = 'json_schema' | 'json_object';

const assistantPlannerSchema = createAssistantPlannerSchema();
export const ASSISTANT_PLANNER_PROMPT_VERSION = 'assistant-logical-plan-v1.1';
export const ASSISTANT_ALIBABA_DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export class AssistantPlannerGatewayError extends Error {
  readonly provider = 'alibaba' as const;

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
  const apiKey = environment.ALIBABA_API_KEY?.trim() ?? '';
  if (!apiKey) throw new AssistantPlannerGatewayError('ALIBABA_API_KEY_MISSING');
  const baseUrl = environment.ASSISTANT_ALIBABA_BASE_URL?.trim() || ASSISTANT_ALIBABA_DEFAULT_BASE_URL;
  const timeoutMs = readAssistantAlibabaTimeoutMs(environment);
  const structuredOutput = readAssistantAlibabaStructuredOutput(environment);
  return new AssistantAlibabaPlannerGateway(apiKey, fetchImplementation, baseUrl, timeoutMs, structuredOutput);
}

export function readAssistantAlibabaTimeoutMs(environment: AssistantEnvironment = process.env) {
  return readBoundedInteger(environment.ASSISTANT_ALIBABA_TIMEOUT_MS, 20_000, 1_000, 120_000);
}

export function readAssistantAlibabaStructuredOutput(
  environment: AssistantEnvironment = process.env,
): AssistantAlibabaStructuredOutput {
  const normalized = (environment.ASSISTANT_ALIBABA_STRUCTURED_OUTPUT ?? 'json_schema')
    .trim().toLocaleLowerCase('en-US');
  if (normalized !== 'json_schema' && normalized !== 'json_object') {
    throw new AssistantPlannerGatewayError('ASSISTANT_ALIBABA_STRUCTURED_OUTPUT_INVALID');
  }
  return normalized;
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

export class AssistantAlibabaPlannerGateway implements AssistantPlannerGateway {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly baseUrl = ASSISTANT_ALIBABA_DEFAULT_BASE_URL,
    private readonly timeoutMs = 20_000,
    private readonly structuredOutput: AssistantAlibabaStructuredOutput = 'json_schema',
  ) {}

  async plan(request: AssistantPlannerRequest): Promise<AssistantPlannerGatewayResult> {
    const remainingMs = request.deadlineAt
      ? request.deadlineAt.getTime() - Date.now()
      : this.timeoutMs;
    if (remainingMs <= 0) {
      throw new AssistantPlannerGatewayError('ASSISTANT_EXECUTION_DEADLINE_EXCEEDED');
    }
    const controller = new AbortController();
    const deadlineLimitsRequest = remainingMs <= this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, remainingMs));
    const clientRequestId = createClientRequestId(request);
    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl.replace(/\/$/u, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'X-Client-Request-Id': clientRequestId,
          },
          body: JSON.stringify(createAssistantPlannerRequestBody(request, this.structuredOutput)),
          signal: controller.signal,
        },
      );
      const requestId = readBoundedString(response.headers.get('x-request-id'), 160);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        if (controller.signal.aborted) {
          throw new AssistantPlannerGatewayError('ASSISTANT_ALIBABA_TIMEOUT', requestId, null, response.status);
        }
        throw new AssistantPlannerGatewayError('ASSISTANT_ALIBABA_MALFORMED_RESPONSE', requestId, null, response.status);
      }
      if (!response.ok) {
        throw new AssistantPlannerGatewayError(`ASSISTANT_ALIBABA_HTTP_${response.status}`, requestId, null, response.status);
      }
      if (!isRecord(value)) {
        throw new AssistantPlannerGatewayError('ASSISTANT_ALIBABA_MALFORMED_RESPONSE', requestId, null, response.status);
      }
      const outputText = readChatCompletionContent(value.choices);
      if (!outputText) {
        throw new AssistantPlannerGatewayError(
          'ASSISTANT_ALIBABA_OUTPUT_MISSING',
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
      const usage = parseAssistantAlibabaUsage(value);
      return {
        output,
        provider: 'alibaba',
        requestId,
        responseId: readBoundedString(value.id, 160),
        httpStatus: response.status,
        ...usage,
      };
    } catch (error) {
      if (error instanceof AssistantPlannerGatewayError) throw error;
      throw new AssistantPlannerGatewayError(controller.signal.aborted
        ? deadlineLimitsRequest
          ? 'ASSISTANT_EXECUTION_DEADLINE_EXCEEDED'
          : 'ASSISTANT_ALIBABA_TIMEOUT'
        : 'ASSISTANT_ALIBABA_NETWORK_ERROR');
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
      'schemaVersion',
      'taskType',
      'comparisonTargets',
      'hardFilters',
      'softPreferences',
      'requiredFacts',
      'needsClarification',
      'clarificationQuestion',
      'clarificationReason',
      'predicates',
    ],
    properties: {
      schemaVersion: { type: 'string', enum: ['AssistantLogicalPlanV1'] },
      taskType: { type: 'string', enum: ['SEARCH', 'OBJECT', 'COMPARE', 'FACT', 'LEGAL_TAX'] },
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
      clarificationReason: {
        type: ['string', 'null'],
        enum: ['AMBIGUOUS_PLACE', 'MISSING_NUMERIC_VALUE', 'CONFLICTING_HARD_CONDITIONS', null],
      },
      predicates: {
        type: 'array',
        maxItems: 2,
        items: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'relation', 'referenceType', 'place'],
              properties: {
                type: { type: 'string', enum: ['SPATIAL'] },
                relation: { type: 'string', enum: ['INSIDE'] },
                referenceType: { type: 'string', enum: ['PLACE'] },
                place: { type: 'string', minLength: 1, maxLength: 240 },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'mode', 'destination', 'operator', 'value', 'unit'],
              properties: {
                type: { type: 'string', enum: ['TRAVEL_TIME'] },
                mode: { type: 'string', enum: ['WALK'] },
                destination: { type: 'string', enum: ['NEAREST_METRO'] },
                operator: { type: 'string', enum: ['LTE'] },
                value: { type: 'integer', minimum: 1, maximum: 240 },
                unit: { type: 'string', enum: ['MINUTES'] },
              },
            },
          ],
        },
      },
    },
  };
}

export function createAssistantPlannerRequestBody(
  request: AssistantPlannerRequest,
  structuredOutput: AssistantAlibabaStructuredOutput = 'json_schema',
) {
  return {
    model: request.model,
    max_tokens: 2_500,
    // DashScope thinking mode is on by default for Qwen chat models; with strict
    // json_schema output it burns the whole token budget on whitespace loops.
    enable_thinking: false,
    messages: [
      {
        role: 'system',
        content: [
          `Contract: ${ASSISTANT_PLANNER_PROMPT_VERSION}.`,
          'Ты Query Planner внутренней Platforma по недвижимости.',
          'Преобразуй полный сырой русскоязычный диалог в строгий AssistantLogicalPlanV1.',
          'Явные условия пользователя всегда являются hard filters. Пожелания без обязательности являются soft preferences.',
          'Не возвращай SQL, координаты или цепочку tool calls.',
          'Не выдумывай названия, числа, единицы, цены, наличие, ссылки или факты: все значения плана должны присутствовать в диалоге.',
          'Если комнатность, бюджет, район, метро, застройщик или срок не названы в диалоге, оставь rooms пустым массивом, а остальные поля null; не подставляй «все варианты» и значения по умолчанию.',
          'objectType всегда RESIDENTIAL, кроме явного запроса коммерческой недвижимости.',
          'Фразы «рядом с», «возле», «около», «у метро», «в радиусе» описывают гео-контекст: не заполняй по ним metro, district и predicates.',
          'predicates допустимы только для явного «внутри/в пределах <место>» и явного лимита минут пешком до метро.',
          'Для SEARCH и COMPARE requiredFacts всегда содержит PRICE, AVAILABILITY, FRESHNESS и LINK.',
          'Для поиска внутри названного места используй только SPATIAL/INSIDE/PLACE.',
          'Для ограничения пешего времени до ближайшего метро используй только TRAVEL_TIME/WALK/NEAREST_METRO/LTE и минуты.',
          'Для налоговых и юридических вопросов выбери LEGAL_TAX. Не давай правовую консультацию.',
          'Для общего поиска, списка или обзорной карточки объектов, ЖК, БЦ и МФК по внутреннему каталогу Platforma выбери OBJECT.',
          'Для текущих квартир, лотов, цен и наличия выбери SEARCH.',
          'Для ипотеки, рассрочки, акций, архитектуры, инфраструктуры и иных подтверждаемых фактов о проекте выбери FACT.',
          'PRICE, AVAILABILITY, FRESHNESS и LINK обязательны только для SEARCH и COMPARE; для OBJECT requiredFacts пуст.',
          'Для явного сравнения двух ЖК или застройщиков заполни comparisonTargets двумя точными названиями.',
          'Не требуй бюджет, комнатность или локацию, если пользователь их не указал.',
          'Уточнение допустимо только для неоднозначного места, отсутствующего числового значения или конфликтующих hard conditions.',
          'Верни только JSON-объект AssistantLogicalPlanV1 без пояснений.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          trust_boundary: 'UNTRUSTED_USER_TEXT',
          dialog: request.dialog
            ?? request.messages.map((content) => ({ role: 'USER', content })),
          page_context: request.context,
        }),
      },
    ],
    response_format: structuredOutput === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: {
            name: 'platforma_assistant_intent',
            strict: true,
            schema: assistantPlannerSchema,
          },
        }
      : { type: 'json_object' },
  };
}

function createDeterministicIntent(messages: string[]): AssistantLogicalPlanV1 {
  const text = messages.join('\n').replace(/ё/giu, 'е');
  const normalized = text.toLocaleLowerCase('ru-RU');
  const logical = extractAssistantLogicalPredicates(messages);
  const hardFilters = {
    ...createEmptyAssistantSearchFilters(),
    ...extractAssistantExplicitHardFilters(messages),
  };
  const conflicting = assistantFiltersHaveConflict(hardFilters);

  const taskType: AssistantLogicalPlanV1['taskType'] = /(?:налог\p{L}*|юрид\p{L}*|договор\p{L}*|закон\p{L}*)/iu.test(normalized)
      ? 'LEGAL_TAX'
      : /сравн\p{L}*/iu.test(normalized)
        ? 'COMPARE'
        : isAssistantExternalKnowledgeFactRequest(normalized)
          || isAssistantObjectKnowledgeFactRequest(normalized)
          ? 'FACT'
          : isAssistantObjectCatalogRequest(normalized) && !isAssistantCurrentOfferRequest(normalized)
            ? 'OBJECT'
            : 'SEARCH';
  return {
    schemaVersion: 'AssistantLogicalPlanV1',
    taskType,
    comparisonTargets: extractAssistantComparisonTargets(messages) ?? [],
    hardFilters,
    softPreferences: createEmptyAssistantSearchFilters(),
    requiredFacts: taskType === 'SEARCH' || taskType === 'COMPARE'
      ? ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK']
      : [],
    predicates: logical.predicates,
    needsClarification: conflicting || logical.missingTravelValue,
    clarificationQuestion: conflicting
      ? ASSISTANT_CLARIFICATION_QUESTIONS.CONFLICTING_HARD_CONDITIONS
      : logical.missingTravelValue
      ? ASSISTANT_CLARIFICATION_QUESTIONS.MISSING_NUMERIC_VALUE
      : null,
    clarificationReason: conflicting ? 'CONFLICTING_HARD_CONDITIONS'
      : logical.missingTravelValue ? 'MISSING_NUMERIC_VALUE' : null,
  };
}

function createClientRequestId(request: AssistantPlannerRequest) {
  const suffix = request.model === ASSISTANT_TERRA_MODEL ? 'terra' : 'luna';
  return `assistant-planner-${suffix}-${Date.now()}`.slice(0, 160);
}

function readChatCompletionContent(value: unknown) {
  if (!Array.isArray(value)) return null;
  for (const choice of value) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    if (typeof choice.message.content === 'string' && choice.message.content.length > 0) {
      return choice.message.content;
    }
  }
  return null;
}

export function parseAssistantAlibabaUsage(value: unknown) {
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
  const promptDetails = usage && isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : null;
  const completionDetails = usage && isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : null;
  return {
    inputTokens: readTokenCount(usage?.prompt_tokens),
    cachedInputTokens: readTokenCount(promptDetails?.cached_tokens),
    cacheWriteInputTokens: 0,
    outputTokens: readTokenCount(usage?.completion_tokens),
    reasoningTokens: readTokenCount(completionDetails?.reasoning_tokens),
    totalTokens: readTokenCount(usage?.total_tokens),
    webSearchCalls: 0,
  };
}

function readTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readAssistantAiMode(environment: AssistantEnvironment): AssistantAiMode {
  const mode = (environment.ASSISTANT_AI_MODE ?? 'fake').trim().toLocaleLowerCase('en-US');
  if (mode !== 'fake' && mode !== 'alibaba') throw new AssistantPlannerGatewayError('ASSISTANT_AI_MODE_INVALID');
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
    throw new AssistantPlannerGatewayError('ASSISTANT_ALIBABA_TIMEOUT_MS_INVALID');
  }
  return parsed;
}

function readBoundedString(value: unknown, maximumLength: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
