import { randomUUID } from 'node:crypto';

import { stripAssistantGeoDistanceClause } from './geo/assistant-geo-query';
import { extractAssistantDistrictFromText } from './geo/assistant-district-query';

export const ASSISTANT_LUNA_MODEL = 'gpt-5.6-luna';
export const ASSISTANT_TERRA_MODEL = 'gpt-5.6-terra';

const filterKeys = [
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
] as const;

const intentKeys = [
  'taskType',
  'comparisonTargets',
  'hardFilters',
  'softPreferences',
  'requiredFacts',
  'needsClarification',
  'clarificationQuestion',
] as const;
const optionalIntentKeys = ['comparisonTargetModes'] as const;

const taskTypes = ['SEARCH', 'OBJECT', 'COMPARE', 'FACT', 'LEGAL_TAX'] as const;
const requiredFactValues = [
  'PRICE',
  'AVAILABILITY',
  'FRESHNESS',
  'LINK',
  'ROOMS',
  'LOCATION',
  'DEVELOPER',
  'COMPLETION',
  'AREA',
  'FLOOR',
  'PDF',
] as const;
const mandatorySearchFacts = ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'] as const;
const complexRequestPattern = /(?:сравн\p{L}*|что\s+лучше|скрыт\p{L}*|компромисс\p{L}*|инвест\p{L}*|приоритет\p{L}*)/iu;
const legalOrTaxPattern = /(?:налог\p{L}*|юрид\p{L}*|закон\p{L}*|договор\p{L}*|право\s+собственности)/iu;
const externalKnowledgeFactPattern = /(?:ипотек\p{L}*|ипотеч\p{L}*|рассроч\p{L}*|акци\p{L}*|скидк\p{L}*|бонус\p{L}*|услови\p{L}*\s+(?:покупк\p{L}*|оплат\p{L}*))/iu;
const objectKnowledgeFactPattern = /(?:архитектур\p{L}*|инфраструктур\p{L}*|благоустрой\p{L}*|паркинг\p{L}*|фасад\p{L}*|наполнен\p{L}*|отделк\p{L}*|интерьер\p{L}*)/iu;
const explicitProjectMarkerPattern = /(?:^|[^\p{L}\p{N}])(?:жк|бц|бизнес[- ]центр|мфк)(?![\p{L}\p{N}])/iu;
const currentKnowledgeStatePattern = /(?:что[^?!.,;:\r\n]{0,80}действ\p{L}*|действ\p{L}*\s+ли|действительно\s+ли)/iu;
const currentOfferPattern = /(?:квартир\p{L}*|апартамент\p{L}*|студи\p{L}*|\d+\s*[- ]?\s*комн\p{L}*|однуш\p{L}*|двуш\p{L}*|треш\p{L}*|лот\p{L}*|бюджет\p{L}*|\bцена\p{L}*|\bстоимост\p{L}*|в\s+продаже|доступн\p{L}*\s+(?:квартир\p{L}*|лот\p{L}*)|площад\p{L}*\s+(?:от|до|не)|этаж\p{L}*\s+(?:от|до|не))/iu;
const objectCatalogPattern = /(?:жк|жилой\s+комплекс|бц|бизнес[- ]центр|мфк|коммерческ\p{L}*|(?:все|каталог\p{L}*|платформ\p{L}*|расскаж\p{L}*|покаж\p{L}*|список\p{L}*)[^\r\n]{0,80}(?:объект\p{L}*|проект\p{L}*)|(?:объект\p{L}*|проект\p{L}*)[^\r\n]{0,80}(?:платформ\p{L}*|каталог\p{L}*))/iu;

export type AssistantTaskType = (typeof taskTypes)[number];
export type AssistantRequiredFact = (typeof requiredFactValues)[number];
export type AssistantObjectType = 'RESIDENTIAL' | 'COMMERCIAL';
export type AssistantReasoningEffort = 'medium' | 'high';
export type AssistantComparisonTargetMode = 'EXACT' | 'INSTRUMENTAL';

export type AssistantSearchFilters = {
  budgetMinRub: number | null;
  budgetMaxRub: number | null;
  rooms: number[];
  district: string | null;
  metro: string | null;
  developer: string | null;
  completionYearMin: number | null;
  completionYearMax: number | null;
  completionQuarter: number | null;
  objectType: AssistantObjectType;
  propertyClass: string | null;
  areaMin: number | null;
  areaMax: number | null;
  floorMin: number | null;
  floorMax: number | null;
};

export type AssistantStructuredIntent = {
  taskType: AssistantTaskType;
  comparisonTargets: string[];
  comparisonTargetModes?: AssistantComparisonTargetMode[];
  hardFilters: AssistantSearchFilters;
  softPreferences: AssistantSearchFilters;
  requiredFacts: AssistantRequiredFact[];
  needsClarification: boolean;
  clarificationQuestion: string | null;
};

export type AssistantPlannerRequest = {
  model: typeof ASSISTANT_LUNA_MODEL | typeof ASSISTANT_TERRA_MODEL;
  reasoningEffort: AssistantReasoningEffort;
  messages: string[];
  context: unknown;
  operationRunId: string;
  executionId: string;
  attemptOrdinal: number;
};

export type AssistantPlannerGateway = {
  plan(request: AssistantPlannerRequest): Promise<unknown>;
};

export type AssistantPhysicalAttemptAllocator = {
  nextAttemptOrdinal(): number;
};

export type AssistantPlannerUsagePolicy = {
  beforeAttempt(request: AssistantPlannerRequest): Promise<unknown>;
  afterAttempt(reservation: unknown, telemetry: AssistantPlannerTelemetry): Promise<void>;
};

export type AssistantPlannerTelemetry = {
  provider: 'fake' | 'openai';
  model: string;
  reasoningEffort: AssistantReasoningEffort;
  outcome: 'ACCEPTED' | 'LOCAL_VALIDATION_FAILED' | 'PROVIDER_ERROR';
  errorCode: string | null;
  isFallback: boolean;
  requestId: string | null;
  responseId: string | null;
  httpStatus: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  webSearchCalls: number | null;
  durationMs: number;
};

export type AssistantPlannerGatewayResult = {
  output: unknown;
  provider?: 'fake' | 'openai';
  requestId?: string | null;
  responseId?: string | null;
  httpStatus?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  webSearchCalls?: number | null;
};

export class AssistantPlannerError extends Error {
  constructor(
    readonly code: string,
    readonly telemetry: AssistantPlannerTelemetry[] = [],
  ) {
    super(code);
    this.name = 'AssistantPlannerError';
  }
}

export class AssistantPlannerFallbackValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantPlannerFallbackValidationError';
  }
}

export class AssistantQueryPlanner {
  constructor(
    private readonly gateway: AssistantPlannerGateway,
    private readonly usagePolicy?: AssistantPlannerUsagePolicy,
  ) {}

  async plan(input: { messages: string[]; context: unknown }) {
    const result = await this.planWithValidation(input, async () => undefined);
    return { intent: result.intent, telemetry: result.telemetry };
  }

  async planWithValidation<Value>(
    input: {
      messages: string[];
      context: unknown;
      operationRunId?: string;
      executionId?: string;
    },
    validate: (
      intent: AssistantStructuredIntent,
      request: AssistantPlannerRequest,
      attempts: AssistantPhysicalAttemptAllocator,
    ) => Promise<Value>,
  ) {
    const messages = normalizeMessages(input.messages);
    const operationRunId = input.operationRunId ?? randomUUID();
    const executionId = input.executionId ?? randomUUID();
    const reasoningEffort = chooseReasoningEffort(messages);
    const attempts: AssistantPlannerTelemetry[] = [];
    let attemptOrdinal = 0;
    const attemptsAllocator: AssistantPhysicalAttemptAllocator = {
      nextAttemptOrdinal: () => {
        attemptOrdinal += 1;
        return attemptOrdinal;
      },
    };
    const requestTemplates: Array<Pick<AssistantPlannerRequest, 'model' | 'reasoningEffort'>> = [
      {
        model: ASSISTANT_LUNA_MODEL,
        reasoningEffort,
      },
      {
        model: ASSISTANT_TERRA_MODEL,
        reasoningEffort: 'medium' as const,
      },
    ];

    for (const [attemptIndex, template] of requestTemplates.entries()) {
      const request: AssistantPlannerRequest = {
        ...template,
        messages,
        context: input.context,
        operationRunId,
        executionId,
        attemptOrdinal: attemptsAllocator.nextAttemptOrdinal(),
      };
      const startedAt = Date.now();
      let gatewayResult: unknown;
      let reservation: unknown;
      try {
        reservation = await this.usagePolicy?.beforeAttempt(request);
        gatewayResult = await this.gateway.plan(request);
      } catch (error) {
        const failure = readPlannerGatewayFailure(error);
        const telemetry = createTelemetry(
          request,
          attemptIndex === 1,
          'PROVIDER_ERROR',
          Date.now() - startedAt,
          failure,
          failure?.errorCode ?? 'ASSISTANT_PLANNER_PROVIDER_FAILED',
        );
        attempts.push(telemetry);
        await this.recordUsage(reservation, telemetry, attempts);
        throw new AssistantPlannerError(failure?.errorCode ?? 'ASSISTANT_PLANNER_PROVIDER_FAILED', attempts);
      }

      const result = unwrapGatewayResult(gatewayResult);
      let intent: AssistantStructuredIntent;
      try {
        const parsedIntent = parseAssistantStructuredIntent(result.output);
        intent = normalizeIntentAgainstRequest(parsedIntent, messages, input.context);
      } catch {
        const telemetry = createTelemetry(
          request,
          attemptIndex === 1,
          'LOCAL_VALIDATION_FAILED',
          Date.now() - startedAt,
          result.metadata,
        );
        attempts.push(telemetry);
        await this.recordUsage(reservation, telemetry, attempts);
        continue;
      }

      let value: Value;
      try {
        value = await validate(intent, request, attemptsAllocator);
      } catch (error) {
        const telemetry = createTelemetry(
          request,
          attemptIndex === 1,
          'LOCAL_VALIDATION_FAILED',
          Date.now() - startedAt,
          result.metadata,
          error instanceof AssistantPlannerFallbackValidationError
            ? error.code
            : 'ASSISTANT_PLANNER_PIPELINE_FAILED',
        );
        attempts.push(telemetry);
        await this.recordUsage(reservation, telemetry, attempts);
        if (!(error instanceof AssistantPlannerFallbackValidationError)) {
          throw new AssistantPlannerError('ASSISTANT_PLANNER_PIPELINE_FAILED', attempts);
        }
        continue;
      }

      const telemetry = createTelemetry(
        request,
        attemptIndex === 1,
        'ACCEPTED',
        Date.now() - startedAt,
        result.metadata,
      );
      attempts.push(telemetry);
      await this.recordUsage(reservation, telemetry, attempts);
      return { intent, value, telemetry: attempts };
    }

    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID', attempts);
  }

  private async recordUsage(
    reservation: unknown,
    telemetry: AssistantPlannerTelemetry,
    attempts: AssistantPlannerTelemetry[],
  ) {
    if (!this.usagePolicy || reservation === undefined) return;
    try {
      await this.usagePolicy.afterAttempt(reservation, telemetry);
    } catch (error) {
      throw new AssistantPlannerError(readUsageSettlementErrorCode(error), [...attempts]);
    }
  }
}

export function createEmptyAssistantSearchFilters(): AssistantSearchFilters {
  return {
    budgetMinRub: null,
    budgetMaxRub: null,
    rooms: [],
    district: null,
    metro: null,
    developer: null,
    completionYearMin: null,
    completionYearMax: null,
    completionQuarter: null,
    objectType: 'RESIDENTIAL',
    propertyClass: null,
    areaMin: null,
    areaMax: null,
    floorMin: null,
    floorMax: null,
  };
}

export function parseAssistantStructuredIntent(value: unknown): AssistantStructuredIntent {
  if (!isRecord(value)
    || intentKeys.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => (
      !intentKeys.includes(key as (typeof intentKeys)[number])
      && !optionalIntentKeys.includes(key as (typeof optionalIntentKeys)[number])
    ))) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  if (!taskTypes.includes(value.taskType as AssistantTaskType)) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }

  const hardFilters = parseFilters(value.hardFilters);
  const softPreferences = parseFilters(value.softPreferences);
  const comparisonTargets = parseComparisonTargets(value.comparisonTargets);
  const comparisonTargetModes = value.comparisonTargetModes === undefined
    ? undefined
    : parseComparisonTargetModes(value.comparisonTargetModes, comparisonTargets.length);
  const requiredFacts = parseRequiredFacts(value.requiredFacts);
  if ((value.taskType === 'SEARCH' || value.taskType === 'COMPARE')
    && mandatorySearchFacts.some((fact) => !requiredFacts.includes(fact))) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }
  if (typeof value.needsClarification !== 'boolean') {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }

  const clarificationQuestion = value.clarificationQuestion === null
    ? null
    : parseBoundedString(value.clarificationQuestion, 300);
  if (value.needsClarification !== Boolean(clarificationQuestion)) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }

  return {
    taskType: value.taskType as AssistantTaskType,
    comparisonTargets,
    ...(comparisonTargetModes ? { comparisonTargetModes } : {}),
    hardFilters,
    softPreferences,
    requiredFacts,
    needsClarification: value.needsClarification,
    clarificationQuestion,
  };
}

function chooseReasoningEffort(messages: string[]): AssistantReasoningEffort {
  return complexRequestPattern.test(messages.join('\n')) ? 'high' : 'medium';
}

function normalizeIntentAgainstRequest(
  intent: AssistantStructuredIntent,
  messages: string[],
  context: unknown,
): AssistantStructuredIntent {
  const explicitFilters = extractAssistantExplicitHardFilters(messages);
  const contextFilters = extractContextHardFilters(context);
  const explicitComparison = extractAssistantComparison(messages);
  const comparisonTargets = explicitComparison?.targets ?? intent.comparisonTargets;
  const comparisonTargetModes = explicitComparison?.modes
    ?? intent.comparisonTargetModes
    ?? comparisonTargets.map(() => 'EXACT' as const);
  const hardMarkedSoftFilters = promoteHardMarkedSoftFilters(intent.softPreferences, messages.join('\n'));
  const mergedHardFilters: AssistantSearchFilters = {
    ...intent.hardFilters,
    ...hardMarkedSoftFilters,
    ...explicitFilters,
    ...contextFilters,
    rooms: contextFilters.rooms ?? explicitFilters.rooms ?? intent.hardFilters.rooms,
  };
  const comparisonNormalizedFilters = isCombinedComparisonDeveloper(mergedHardFilters.developer, comparisonTargets)
    ? { ...mergedHardFilters, developer: null }
    : mergedHardFilters;
  const hardFilters = consumeDistrictResolvedAsGeo(comparisonNormalizedFilters, context);
  const requestText = messages.join('\n');
  const isLegalOrTax = legalOrTaxPattern.test(requestText);
  if (isLegalOrTax) {
    return {
      ...intent,
      taskType: 'LEGAL_TAX',
      comparisonTargets: [],
      comparisonTargetModes: [],
      hardFilters,
      needsClarification: false,
      clarificationQuestion: null,
    };
  }

  const taskType = intent.taskType === 'COMPARE'
    ? 'COMPARE'
    : intent.taskType === 'FACT'
      || isAssistantExternalKnowledgeFactRequest(requestText)
      || isAssistantObjectKnowledgeFactRequest(requestText)
      ? 'FACT'
      : isAssistantObjectCatalogRequest(requestText) && !isAssistantCurrentOfferRequest(requestText)
        ? 'OBJECT'
        : intent.taskType;

  if (taskType === 'FACT') {
    return { ...intent, hardFilters, comparisonTargets, comparisonTargetModes };
  }
  if (taskType === 'OBJECT') {
    return {
      ...intent,
      taskType,
      hardFilters,
      comparisonTargets: [],
      comparisonTargetModes: [],
      requiredFacts: [],
      needsClarification: false,
      clarificationQuestion: null,
    };
  }

  const missingFacts: string[] = [];
  if (hardFilters.budgetMaxRub === null) missingFacts.push('максимальный бюджет');
  if (hardFilters.objectType === 'RESIDENTIAL' && hardFilters.rooms.length === 0) {
    missingFacts.push('комнатность');
  }
  if (!hasLocationConstraint(hardFilters, context)) missingFacts.push('район или метро');

  return {
    ...intent,
    comparisonTargets,
    comparisonTargetModes,
    hardFilters,
    needsClarification: missingFacts.length > 0,
    clarificationQuestion: missingFacts.length > 0
      ? `Уточните, пожалуйста: ${joinRussianList(missingFacts)}.`
      : null,
  };
}

export function isAssistantObjectCatalogRequest(value: string) {
  return objectCatalogPattern.test(value);
}

export function isAssistantCurrentOfferRequest(value: string) {
  return currentOfferPattern.test(value);
}

export function isAssistantExternalKnowledgeFactRequest(value: string) {
  return externalKnowledgeFactPattern.test(value);
}

export function isAssistantObjectKnowledgeFactRequest(value: string) {
  return objectKnowledgeFactPattern.test(value)
    || (explicitProjectMarkerPattern.test(value) && currentKnowledgeStatePattern.test(value));
}

function isCombinedComparisonDeveloper(value: string | null, comparisonTargets: string[]) {
  if (!value || comparisonTargets.length !== 2) return false;
  const normalizedValue = normalizeComparableText(value);
  return comparisonTargets.every((target) => normalizedValue.includes(normalizeComparableText(target)));
}

function consumeDistrictResolvedAsGeo(filters: AssistantSearchFilters, context: unknown): AssistantSearchFilters {
  if (!filters.district || !isRecord(context) || !isRecord(context.districtResolution)) {
    return filters;
  }
  const resolution = context.districtResolution;
  if (typeof resolution.input !== 'string'
    || normalizeComparableText(filters.district) !== normalizeComparableText(resolution.input)) return filters;
  if (resolution.resolvedByGeo === true
    && resolution.canonicalName === null
    && hasGeoContext(context)
    && plannerGeoHasTrustedLandmark(context.geo)) {
    return { ...filters, district: null };
  }
  if (resolution.resolvedByGeo === false
    && typeof resolution.canonicalName === 'string'
    && resolution.canonicalName.trim()
    && resolution.canonicalName.length <= 160) {
    return { ...filters, district: resolution.canonicalName.trim() };
  }
  return filters;
}

export function extractAssistantComparisonTargets(messages: string[]) {
  return extractAssistantComparison(messages)?.targets ?? null;
}

function extractAssistantComparison(messages: string[]) {
  const text = messages.join('\n');
  const match = text.match(
    /сравн\p{L}*\s+(?:застройщик\p{L}*\s+|жк\s+)?(?<firstQuote>[«"]?)(?<first>.+?)[»"]?\s+(?<conjunction>и|с)\s+(?<secondQuote>[«"]?)(?<second>.+?)[»"]?(?=\s+(?:по\s+(?:цен|стоим|услов|срок|сдач|локац|располож|инфраструкт|доход|ликвид|планиров|площад|метро)\p{L}*|до\s+\d|бюджет\p{L}*|в\s+район)|[,.;\r\n]|$)/iu,
  );
  if (!match?.groups) return null;
  const first = cleanComparisonTarget(match.groups.first);
  const rawSecond = cleanComparisonTarget(match.groups.second);
  const isInstrumental = normalizeComparableText(match.groups.conjunction ?? '') === 'с'
    && !match.groups.secondQuote;
  const targets = [first, rawSecond];
  const genericTargets = new Set(['вариант', 'варианты', 'объект', 'объекты', 'цены', 'предложения']);
  if (targets.some((target) => !target || target.length > 160 || genericTargets.has(normalizeComparableText(target)))) {
    return null;
  }
  return {
    targets,
    modes: ['EXACT', isInstrumental ? 'INSTRUMENTAL' : 'EXACT'] as AssistantComparisonTargetMode[],
  };
}

function normalizeComparableText(value: string) {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').trim();
}

function cleanComparisonTarget(value: string | undefined) {
  return value?.trim().replace(/^[«"]|[»"]$/gu, '') ?? '';
}

export function createAssistantComparisonTargetVariants(
  target: string,
  mode: AssistantComparisonTargetMode = 'EXACT',
) {
  if (mode !== 'INSTRUMENTAL') return [target];
  const maxVariants = 12;
  const endings: Array<[string, string[]]> = [
    ['оем', ['ой']],
    ['ью', ['ь']],
    ['ою', ['а', 'я', 'ая']],
    ['ею', ['я', 'е', 'яя']],
    ['ьим', ['ий']],
    ['ым', ['ый', 'ой']],
    ['им', ['ий', 'ой']],
    ['ом', ['']],
    ['ем', ['е', 'ь']],
    ['ой', ['а', 'я', 'ая']],
    ['ей', ['я', 'е', 'яя']],
  ];

  const parts = target.split(/([\p{L}]+)/u);
  const choices = parts.map((part, index) => {
    if (index % 2 === 0) return [part];
    const normalizedWord = normalizeComparableText(part);
    for (const [ending, replacements] of endings) {
      if (!normalizedWord.endsWith(ending)) continue;
      const stem = part.slice(0, -ending.length);
      if ([...stem].length < 3) break;
      return [...replacements.map((replacement) => `${stem}${replacement}`), part];
    }
    return [part];
  });

  let combinations = [''];
  for (const partChoices of choices) {
    const next: string[] = [];
    for (const prefix of combinations) {
      for (const choice of partChoices) {
        next.push(`${prefix}${choice}`);
        if (next.length >= maxVariants) break;
      }
      if (next.length >= maxVariants) break;
    }
    combinations = next;
  }

  const seen = new Set<string>();
  return [target, ...combinations].filter((variant) => {
    const normalized = normalizeComparableText(variant);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, maxVariants);
}

export function extractAssistantExplicitHardFilters(
  messages: string[],
): Partial<AssistantSearchFilters> & { rooms?: number[] } {
  return extractExplicitFilters(messages.join('\n'));
}

export function extractAssistantExplicitDistrict(text: string, requireInPrefix = false) {
  const textWithoutGeoDistance = stripGeoDistancePhrases(text);
  return extractAssistantDistrictFromText(textWithoutGeoDistance, requireInPrefix);
}

function extractExplicitFilters(text: string): Partial<AssistantSearchFilters> & { rooms?: number[] } {
  const filters: Partial<AssistantSearchFilters> & { rooms?: number[] } = {};
  const normalized = text.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
  const textWithoutGeoDistance = stripGeoDistancePhrases(text);
  const rangeMatch = normalized.match(
    /(?:бюджет\s*)?(?:от\s*)?(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|миллион(?:а|ов)?|тыс\p{L}*|руб\p{L}*)?\s*(?:до|-|–|—)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|миллион(?:а|ов)?|тыс\p{L}*|руб\p{L}*)/iu,
  );
  if (rangeMatch) {
    filters.budgetMinRub = parseMoneyText(rangeMatch[1]!, rangeMatch[2] ?? rangeMatch[4]!);
    filters.budgetMaxRub = parseMoneyText(rangeMatch[3]!, rangeMatch[4]!);
  } else {
    const maximumMatch = normalized.match(
      /(?:бюджет\s*)?(?:до|не\s+дороже|максимум)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|миллион(?:а|ов)?|тыс\p{L}*|руб\p{L}*)/iu,
    );
    const minimumMatch = normalized.match(
      /(?:бюджет\s*)?(?:от|не\s+дешевле|минимум)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|миллион(?:а|ов)?|тыс\p{L}*|руб\p{L}*)/iu,
    );
    if (maximumMatch) filters.budgetMaxRub = parseMoneyText(maximumMatch[1]!, maximumMatch[2]!);
    if (minimumMatch) filters.budgetMinRub = parseMoneyText(minimumMatch[1]!, minimumMatch[2]!);
  }

  const rooms = new Set<number>();
  for (const match of normalized.matchAll(/(?:^|[^\p{L}\d])(\d{1,2})\s*[- ]?\s*комн\p{L}*/giu)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value >= 0 && value <= 10) rooms.add(value);
  }
  if (/(?:студи\p{L}*)/iu.test(normalized)) rooms.add(0);
  if (/(?:однуш\p{L}*|однокомнат\p{L}*)/iu.test(normalized)) rooms.add(1);
  if (/(?:двуш\p{L}*|двухкомнат\p{L}*)/iu.test(normalized)) rooms.add(2);
  if (/(?:треш\p{L}*|трехкомнат\p{L}*)/iu.test(normalized)) rooms.add(3);
  if (rooms.size > 0) filters.rooms = [...rooms].sort((left, right) => left - right);

  const district = extractAssistantExplicitDistrict(text);
  if (district) filters.district = district;
  const metro = extractNamedCondition(
    textWithoutGeoDistance,
    /(?:у\s+)?метро\s+[«"]?(.+?)[»"]?(?=\s+(?:от\s+[\p{L}«"]|сдач\p{L}*|\d+\s*квартал)|[,.;\r\n]|$)/iu,
  );
  if (metro) filters.metro = metro;
  const developer = extractNamedCondition(
    textWithoutGeoDistance,
    /(?:(?:от\s+)?застройщик(?:а|ом)?|от\s+(?=[\p{L}«"]))\s*[«"]?(.+?)[»"]?(?=\s+(?:сдач\p{L}*|\d+\s*квартал)|[,.;\r\n]|$)/iu,
  );
  if (developer) filters.developer = developer;

  const completionMaximum = normalized.match(/(?:сдач\p{L}*\s+)?(?:до|не\s+позднее)\s+(20\d{2})/iu);
  const completionMinimum = normalized.match(/(?:сдач\p{L}*\s+)?(?:от|не\s+раньше)\s+(20\d{2})/iu);
  const completionExact = normalized.match(/(?:сдач\p{L}*|готов\p{L}*)[^\d]{0,16}(20\d{2})/iu);
  if (completionMaximum) filters.completionYearMax = Number(completionMaximum[1]);
  if (completionMinimum) filters.completionYearMin = Number(completionMinimum[1]);
  if (!completionMaximum && !completionMinimum && completionExact) {
    filters.completionYearMin = Number(completionExact[1]);
    filters.completionYearMax = Number(completionExact[1]);
  }
  const completionQuarter = normalized.match(/([1-4])\s*(?:кв\.?|квартал)/iu);
  if (completionQuarter) filters.completionQuarter = Number(completionQuarter[1]);

  const propertyClass = normalized.match(/(?:класс(?:а)?\s+)?(комфорт|бизнес|премиум|элит)\s*[- ]?класс/iu);
  if (propertyClass) filters.propertyClass = propertyClass[1]!;
  const areaMinimum = normalized.match(/(?:площад\p{L}*\s+)?(?:от|не\s+меньше)\s+(\d+(?:[.,]\d+)?)\s*(?:м2|м²|кв)/iu);
  const areaMaximum = normalized.match(/(?:площад\p{L}*\s+)?(?:до|не\s+больше)\s+(\d+(?:[.,]\d+)?)\s*(?:м2|м²|кв)/iu);
  const areaRange = normalized.match(/(?:площад\p{L}*\s+)?(\d+(?:[.,]\d+)?)\s*(?:-|–|—|до)\s*(\d+(?:[.,]\d+)?)\s*(?:м2|м²|кв)/iu);
  if (areaRange) {
    filters.areaMin = Number(areaRange[1]!.replace(',', '.'));
    filters.areaMax = Number(areaRange[2]!.replace(',', '.'));
  }
  if (areaMinimum) filters.areaMin = Number(areaMinimum[1]!.replace(',', '.'));
  if (areaMaximum) filters.areaMax = Number(areaMaximum[1]!.replace(',', '.'));
  const floorMinimum = normalized.match(
    /(?:этаж\p{L}*\s+(?:от|не\s+ниже)\s+(-?\d+)|(?:от|не\s+ниже)\s+(-?\d+)\s*этаж\p{L}*)/iu,
  );
  const floorMaximum = normalized.match(
    /(?:этаж\p{L}*\s+(?:до|не\s+выше)\s+(-?\d+)|(?:до|не\s+выше)\s+(-?\d+)\s*этаж\p{L}*)/iu,
  );
  if (floorMinimum) filters.floorMin = Number(floorMinimum[1] ?? floorMinimum[2]);
  if (floorMaximum) filters.floorMax = Number(floorMaximum[1] ?? floorMaximum[2]);
  if (/коммерчес\p{L}*/iu.test(normalized)) filters.objectType = 'COMMERCIAL';
  if (/(?:жил\p{L}*|квартир\p{L}*|апартамент\p{L}*)/iu.test(normalized)) filters.objectType = 'RESIDENTIAL';

  return filters;
}

function promoteHardMarkedSoftFilters(
  softPreferences: AssistantSearchFilters,
  text: string,
): Partial<AssistantSearchFilters> {
  const normalizedText = normalizeComparableText(text);
  const promoted: Partial<AssistantSearchFilters> = {};
  for (const key of ['district', 'metro', 'developer', 'propertyClass'] as const) {
    const value = softPreferences[key];
    if (!value) continue;
    const normalizedValue = normalizeComparableText(value);
    if (['только', 'строго', 'обязательно', 'исключительно'].some((marker) =>
      normalizedText.includes(`${marker} ${normalizedValue}`)
      || normalizedText.includes(`${marker} в ${normalizedValue}`))) {
      promoted[key] = value;
    }
  }
  return promoted;
}

function extractContextHardFilters(context: unknown): Partial<AssistantSearchFilters> {
  const pageContext = readPageContext(context);
  if (!isRecord(pageContext) || pageContext.kind !== 'CATALOG_FILTERS' || typeof pageContext.key !== 'string') return {};
  const params = new URLSearchParams(pageContext.key);
  const objectType = params.get('type');
  const filters: Partial<AssistantSearchFilters> = {};
  if (objectType === 'RESIDENTIAL' || objectType === 'COMMERCIAL') filters.objectType = objectType;
  const rooms = parseContextIntegerList(params.get('lotRooms'), 0, 10);
  if (rooms.length > 0) filters.rooms = rooms;
  const budgetMinimum = parseContextNumber(params.get('lotPriceMin'), 0, 1_000_000_000_000);
  const budgetMaximum = parseContextNumber(params.get('lotPriceMax'), 0, 1_000_000_000_000);
  if (budgetMinimum !== null) filters.budgetMinRub = budgetMinimum;
  if (budgetMaximum !== null) filters.budgetMaxRub = budgetMaximum;
  const completionYear = parseContextInteger(params.get('completionYear'), 1900, 2200);
  if (completionYear !== null) {
    filters.completionYearMin = completionYear;
    filters.completionYearMax = completionYear;
  }
  const floorMinimum = parseContextInteger(params.get('lotFloorMin'), -20, 500);
  const floorMaximum = parseContextInteger(params.get('lotFloorMax'), -20, 500);
  if (floorMinimum !== null) filters.floorMin = floorMinimum;
  if (floorMaximum !== null) filters.floorMax = floorMaximum;
  return filters;
}

function parseContextIntegerList(value: string | null, minimum: number, maximum: number) {
  if (!value) return [];
  return [...new Set(value.split(',').flatMap((item) => {
    const parsed = parseContextInteger(item, minimum, maximum);
    return parsed === null ? [] : [parsed];
  }))];
}

function parseContextInteger(value: string | null, minimum: number, maximum: number) {
  if (value === null || !/^-?\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function parseContextNumber(value: string | null, minimum: number, maximum: number) {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function extractNamedCondition(text: string, pattern: RegExp) {
  const match = text.match(pattern)?.[1]?.trim().replace(/^[«"]|[»"]$/gu, '');
  return match && match.length <= 160 ? match : null;
}

function parseMoneyText(value: string, unit: string) {
  const amount = Number(value.replace(/\s+/gu, '').replace(',', '.'));
  const multiplier = unit.startsWith('млн') || unit.startsWith('миллион')
    ? 1_000_000
    : unit.startsWith('тыс')
      ? 1_000
      : 1;
  return Math.round(amount * multiplier);
}

function hasLocationConstraint(filters: AssistantSearchFilters, context: unknown) {
  if (filters.district || filters.metro || filters.developer) return true;
  if (hasGeoContext(context)) return true;
  const pageContext = readPageContext(context);
  if (!isRecord(pageContext) || typeof pageContext.kind !== 'string') return false;
  if (pageContext.kind === 'OBJECT' || pageContext.kind === 'LOT' || pageContext.kind === 'DEVELOPER') return true;
  if (pageContext.kind !== 'CATALOG_FILTERS' || typeof pageContext.key !== 'string') return false;
  const params = new URLSearchParams(pageContext.key);
  return ['developerId', 'locationId', 'areaId', 'metroStationId']
    .some((key) => Boolean(params.get(key)));
}

function readPageContext(context: unknown) {
  return isRecord(context) && 'pageContext' in context ? context.pageContext : context;
}

function hasGeoContext(context: unknown) {
  if (!isRecord(context) || !isRecord(context.geo)) return false;
  if (context.geo.hasGeoConstraint !== true) return false;
  if (context.geo.operator === 'ALL') {
    return Array.isArray(context.geo.constraints)
      && context.geo.constraints.length >= 1
      && context.geo.constraints.length <= 5
      && context.geo.constraints.every((constraint) => isRecord(constraint)
        && ['POINT', 'LINE', 'AREA'].includes(String(constraint.kind))
        && ['NEAR', 'INSIDE'].includes(String(constraint.mode)));
  }
  return ['POINT', 'LINE', 'AREA'].includes(String(context.geo.kind))
    && ['NEAR', 'INSIDE'].includes(String(context.geo.mode));
}

function plannerGeoHasTrustedLandmark(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.operator === 'ALL') {
    return Array.isArray(value.constraints) && value.constraints.some((constraint) =>
      isRecord(constraint)
      && constraint.source === 'LANDMARK'
      && typeof constraint.landmarkId === 'string');
  }
  return value.source === 'LANDMARK' && typeof value.landmarkId === 'string';
}

function joinRussianList(values: string[]) {
  if (values.length < 2) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} и ${values[values.length - 1]}`;
}

function normalizeMessages(messages: string[]) {
  const normalized = messages
    .filter((message): message is string => typeof message === 'string')
    .map((message) => message.trim().replace(/\s+/gu, ' '))
    .filter(Boolean)
    .slice(-20);
  if (normalized.length === 0) throw new AssistantPlannerError('ASSISTANT_MESSAGES_INVALID');
  return normalized;
}

function parseFilters(value: unknown): AssistantSearchFilters {
  if (!isExactRecord(value, filterKeys)) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');

  const filters: AssistantSearchFilters = {
    budgetMinRub: parseNullableNumber(value.budgetMinRub, 0, 1_000_000_000_000),
    budgetMaxRub: parseNullableNumber(value.budgetMaxRub, 0, 1_000_000_000_000),
    rooms: parseRooms(value.rooms),
    district: parseNullableString(value.district, 160),
    metro: parseNullableString(value.metro, 160),
    developer: parseNullableString(value.developer, 160),
    completionYearMin: parseNullableInteger(value.completionYearMin, 1900, 2200),
    completionYearMax: parseNullableInteger(value.completionYearMax, 1900, 2200),
    completionQuarter: parseNullableInteger(value.completionQuarter, 1, 4),
    objectType: parseObjectType(value.objectType),
    propertyClass: parseNullableString(value.propertyClass, 120),
    areaMin: parseNullableNumber(value.areaMin, 0, 100_000),
    areaMax: parseNullableNumber(value.areaMax, 0, 100_000),
    floorMin: parseNullableInteger(value.floorMin, -20, 500),
    floorMax: parseNullableInteger(value.floorMax, -20, 500),
  };

  assertValidRange(filters.budgetMinRub, filters.budgetMaxRub);
  assertValidRange(filters.completionYearMin, filters.completionYearMax);
  assertValidRange(filters.areaMin, filters.areaMax);
  assertValidRange(filters.floorMin, filters.floorMax);
  return filters;
}

function parseRequiredFacts(value: unknown): AssistantRequiredFact[] {
  if (!Array.isArray(value) || value.length > requiredFactValues.length) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }
  const facts = value.map((fact) => {
    if (!requiredFactValues.includes(fact as AssistantRequiredFact)) {
      throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
    }
    return fact as AssistantRequiredFact;
  });
  if (new Set(facts).size !== facts.length) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  return facts;
}

function parseComparisonTargets(value: unknown) {
  if (!Array.isArray(value) || value.length > 2) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  const targets = value.map((target) => parseBoundedString(target, 160));
  if (new Set(targets.map(normalizeComparableText)).size !== targets.length) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }
  return targets;
}

function parseComparisonTargetModes(value: unknown, targetCount: number) {
  if (!Array.isArray(value) || value.length !== targetCount) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }
  return value.map((mode) => {
    if (mode !== 'EXACT' && mode !== 'INSTRUMENTAL') {
      throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
    }
    return mode;
  });
}

function stripGeoDistancePhrases(value: string) {
  return stripAssistantGeoDistanceClause(value);
}

function parseRooms(value: unknown) {
  if (!Array.isArray(value) || value.length > 11) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  const rooms = value.map((room) => {
    if (!Number.isInteger(room) || (room as number) < 0 || (room as number) > 10) {
      throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
    }
    return room as number;
  });
  if (new Set(rooms).size !== rooms.length) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  return rooms;
}

function parseNullableNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }
  return value;
}

function parseNullableInteger(value: unknown, minimum: number, maximum: number) {
  const parsed = parseNullableNumber(value, minimum, maximum);
  if (parsed !== null && !Number.isInteger(parsed)) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  return parsed;
}

function parseNullableString(value: unknown, maximumLength: number) {
  if (value === null) return null;
  return parseBoundedString(value, maximumLength);
}

function parseBoundedString(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > maximumLength) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  return normalized;
}

function parseObjectType(value: unknown): AssistantObjectType {
  if (value !== 'RESIDENTIAL' && value !== 'COMMERCIAL') {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }
  return value;
}

function assertValidRange(minimum: number | null, maximum: number | null) {
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }
}

function unwrapGatewayResult(value: unknown) {
  if (isRecord(value) && Object.hasOwn(value, 'output')) {
    return {
      output: value.output,
      metadata: value as AssistantPlannerGatewayResult,
    };
  }
  return { output: value, metadata: null };
}

function createTelemetry(
  request: AssistantPlannerRequest,
  isFallback: boolean,
  outcome: AssistantPlannerTelemetry['outcome'],
  durationMs: number,
  metadata: Partial<AssistantPlannerGatewayResult> | null = null,
  errorCode: string | null = null,
): AssistantPlannerTelemetry {
  return {
    provider: metadata?.provider ?? 'fake',
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    outcome,
    errorCode: readNullableBoundedString(errorCode, 120),
    isFallback,
    requestId: readNullableBoundedString(metadata?.requestId, 160),
    responseId: readNullableBoundedString(metadata?.responseId, 160),
    httpStatus: readNullableInteger(metadata?.httpStatus, 100, 599),
    inputTokens: readNullableInteger(metadata?.inputTokens, 0, Number.MAX_SAFE_INTEGER),
    cachedInputTokens: readNullableInteger(metadata?.cachedInputTokens, 0, Number.MAX_SAFE_INTEGER),
    cacheWriteInputTokens: readNullableInteger(metadata?.cacheWriteInputTokens, 0, Number.MAX_SAFE_INTEGER),
    outputTokens: readNullableInteger(metadata?.outputTokens, 0, Number.MAX_SAFE_INTEGER),
    reasoningTokens: readNullableInteger(metadata?.reasoningTokens, 0, Number.MAX_SAFE_INTEGER),
    totalTokens: readNullableInteger(metadata?.totalTokens, 0, Number.MAX_SAFE_INTEGER),
    webSearchCalls: readNullableInteger(metadata?.webSearchCalls, 0, Number.MAX_SAFE_INTEGER),
    durationMs: Math.max(0, Math.trunc(durationMs)),
  };
}

function readPlannerGatewayFailure(error: unknown): {
  provider: 'fake' | 'openai';
  errorCode: string;
  requestId: string | null;
  responseId: string | null;
  httpStatus: number | null;
} | null {
  if (!isRecord(error) || (error.provider !== 'openai' && error.provider !== 'fake')) return null;
  const errorCode = readNullableBoundedString(error.code, 120);
  if (!errorCode) return null;
  return {
    provider: error.provider,
    errorCode,
    requestId: readNullableBoundedString(error.requestId, 160),
    responseId: readNullableBoundedString(error.responseId, 160),
    httpStatus: readNullableInteger(error.httpStatus, 100, 599),
  };
}

function readUsageSettlementErrorCode(error: unknown) {
  if (isRecord(error)
    && typeof error.code === 'string'
    && /^ASSISTANT_(?:AI|MODEL)_[A-Z0-9_]+$/u.test(error.code)) {
    return error.code;
  }
  return 'ASSISTANT_AI_USAGE_SETTLEMENT_FAILED';
}

function readNullableBoundedString(value: unknown, maximumLength: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength ? value : null;
}

function readNullableInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function isExactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): value is Record<Keys[number], unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
