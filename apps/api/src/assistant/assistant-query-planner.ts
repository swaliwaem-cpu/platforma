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
  'hardFilters',
  'softPreferences',
  'requiredFacts',
  'needsClarification',
  'clarificationQuestion',
] as const;

const taskTypes = ['SEARCH', 'COMPARE', 'FACT', 'LEGAL_TAX'] as const;
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

export type AssistantTaskType = (typeof taskTypes)[number];
export type AssistantRequiredFact = (typeof requiredFactValues)[number];
export type AssistantObjectType = 'RESIDENTIAL' | 'COMMERCIAL';
export type AssistantReasoningEffort = 'medium' | 'high';

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
};

export type AssistantPlannerGateway = {
  plan(request: AssistantPlannerRequest): Promise<unknown>;
};

export type AssistantPlannerTelemetry = {
  provider: 'fake' | 'openai';
  model: string;
  reasoningEffort: AssistantReasoningEffort;
  outcome: 'ACCEPTED' | 'LOCAL_VALIDATION_FAILED' | 'PROVIDER_ERROR';
  isFallback: boolean;
  requestId: string | null;
  responseId: string | null;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
};

export type AssistantPlannerGatewayResult = {
  output: unknown;
  provider?: 'fake' | 'openai';
  requestId?: string | null;
  responseId?: string | null;
  httpStatus?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
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

export class AssistantQueryPlanner {
  constructor(private readonly gateway: AssistantPlannerGateway) {}

  async plan(input: { messages: string[]; context: unknown }) {
    const result = await this.planWithValidation(input, async () => undefined);
    return { intent: result.intent, telemetry: result.telemetry };
  }

  async planWithValidation<Value>(
    input: { messages: string[]; context: unknown },
    validate: (intent: AssistantStructuredIntent, request: AssistantPlannerRequest) => Promise<Value>,
  ) {
    const messages = normalizeMessages(input.messages);
    const reasoningEffort = chooseReasoningEffort(messages);
    const attempts: AssistantPlannerTelemetry[] = [];
    const requests: AssistantPlannerRequest[] = [
      {
        model: ASSISTANT_LUNA_MODEL,
        reasoningEffort,
        messages,
        context: input.context,
      },
      {
        model: ASSISTANT_TERRA_MODEL,
        reasoningEffort: 'medium',
        messages,
        context: input.context,
      },
    ];

    for (const [attemptIndex, request] of requests.entries()) {
      const startedAt = Date.now();
      let gatewayResult: unknown;
      try {
        gatewayResult = await this.gateway.plan(request);
      } catch {
        attempts.push(createTelemetry(request, attemptIndex === 1, 'PROVIDER_ERROR', Date.now() - startedAt));
        throw new AssistantPlannerError('ASSISTANT_PLANNER_PROVIDER_FAILED', attempts);
      }

      const result = unwrapGatewayResult(gatewayResult);
      try {
        const parsedIntent = parseAssistantStructuredIntent(result.output);
        const intent = normalizeIntentAgainstRequest(parsedIntent, messages, input.context);
        const value = await validate(intent, request);
        attempts.push(createTelemetry(
          request,
          attemptIndex === 1,
          'ACCEPTED',
          Date.now() - startedAt,
          result.metadata,
        ));
        return { intent, value, telemetry: attempts };
      } catch {
        attempts.push(createTelemetry(
          request,
          attemptIndex === 1,
          'LOCAL_VALIDATION_FAILED',
          Date.now() - startedAt,
          result.metadata,
        ));
      }
    }

    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID', attempts);
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
  if (!isExactRecord(value, intentKeys)) throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  if (!taskTypes.includes(value.taskType as AssistantTaskType)) {
    throw new AssistantPlannerError('ASSISTANT_INTENT_INVALID');
  }

  const hardFilters = parseFilters(value.hardFilters);
  const softPreferences = parseFilters(value.softPreferences);
  const requiredFacts = parseRequiredFacts(value.requiredFacts);
  if (value.taskType !== 'LEGAL_TAX' && mandatorySearchFacts.some((fact) => !requiredFacts.includes(fact))) {
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
    hardFilters,
    softPreferences,
    requiredFacts,
    needsClarification: value.needsClarification,
    clarificationQuestion,
  };
}

function chooseReasoningEffort(messages: string[]): AssistantReasoningEffort {
  const latest = messages[messages.length - 1] ?? '';
  return complexRequestPattern.test(latest) ? 'high' : 'medium';
}

function normalizeIntentAgainstRequest(
  intent: AssistantStructuredIntent,
  messages: string[],
  context: unknown,
): AssistantStructuredIntent {
  const explicitFilters = extractExplicitFilters(messages.join('\n'));
  const hardFilters: AssistantSearchFilters = {
    ...intent.hardFilters,
    ...explicitFilters,
    rooms: explicitFilters.rooms ?? intent.hardFilters.rooms,
  };
  const isLegalOrTax = messages.some((message) => legalOrTaxPattern.test(message));
  if (isLegalOrTax) {
    return {
      ...intent,
      taskType: 'LEGAL_TAX',
      hardFilters,
      needsClarification: false,
      clarificationQuestion: null,
    };
  }

  if (intent.taskType === 'FACT') {
    return { ...intent, hardFilters };
  }

  const missingFacts: string[] = [];
  if (hardFilters.budgetMaxRub === null) missingFacts.push('максимальный бюджет');
  if (hardFilters.objectType === 'RESIDENTIAL' && hardFilters.rooms.length === 0) {
    missingFacts.push('комнатность');
  }
  if (!hasLocationConstraint(hardFilters, context)) missingFacts.push('район или метро');

  return {
    ...intent,
    hardFilters,
    needsClarification: missingFacts.length > 0,
    clarificationQuestion: missingFacts.length > 0
      ? `Уточните, пожалуйста: ${joinRussianList(missingFacts)}.`
      : null,
  };
}

function extractExplicitFilters(text: string): Partial<AssistantSearchFilters> & { rooms?: number[] } {
  const filters: Partial<AssistantSearchFilters> & { rooms?: number[] } = {};
  const normalized = text.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
  const rangeMatch = normalized.match(
    /(?:бюджет\s*)?(?:от\s*)?(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|тыс\p{L}*|руб\p{L}*)?\s*(?:до|-|–|—)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|тыс\p{L}*|руб\p{L}*)/iu,
  );
  if (rangeMatch) {
    filters.budgetMinRub = parseMoneyText(rangeMatch[1]!, rangeMatch[2] ?? rangeMatch[4]!);
    filters.budgetMaxRub = parseMoneyText(rangeMatch[3]!, rangeMatch[4]!);
  } else {
    const maximumMatch = normalized.match(
      /(?:бюджет\s*)?(?:до|не\s+дороже|максимум)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|тыс\p{L}*|руб\p{L}*)/iu,
    );
    const minimumMatch = normalized.match(
      /(?:бюджет\s*)?(?:от|не\s+дешевле|минимум)\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(млн\p{L}*|тыс\p{L}*|руб\p{L}*)/iu,
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

  return filters;
}

function parseMoneyText(value: string, unit: string) {
  const amount = Number(value.replace(/\s+/gu, '').replace(',', '.'));
  const multiplier = unit.startsWith('млн')
    ? 1_000_000
    : unit.startsWith('тыс')
      ? 1_000
      : 1;
  return Math.round(amount * multiplier);
}

function hasLocationConstraint(filters: AssistantSearchFilters, context: unknown) {
  if (filters.district || filters.metro || filters.developer) return true;
  if (!isRecord(context) || typeof context.kind !== 'string') return false;
  if (context.kind === 'OBJECT' || context.kind === 'LOT' || context.kind === 'DEVELOPER') return true;
  if (context.kind !== 'CATALOG_FILTERS' || typeof context.key !== 'string') return false;
  const params = new URLSearchParams(context.key);
  return ['districtId', 'metroId', 'developerId', 'locationId']
    .some((key) => Boolean(params.get(key)));
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
  metadata: AssistantPlannerGatewayResult | null = null,
): AssistantPlannerTelemetry {
  return {
    provider: metadata?.provider ?? 'fake',
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    outcome,
    isFallback,
    requestId: readNullableBoundedString(metadata?.requestId, 160),
    responseId: readNullableBoundedString(metadata?.responseId, 160),
    httpStatus: readNullableInteger(metadata?.httpStatus, 100, 599),
    inputTokens: readNullableInteger(metadata?.inputTokens, 0, Number.MAX_SAFE_INTEGER),
    outputTokens: readNullableInteger(metadata?.outputTokens, 0, Number.MAX_SAFE_INTEGER),
    reasoningTokens: readNullableInteger(metadata?.reasoningTokens, 0, Number.MAX_SAFE_INTEGER),
    totalTokens: readNullableInteger(metadata?.totalTokens, 0, Number.MAX_SAFE_INTEGER),
    durationMs: Math.max(0, Math.trunc(durationMs)),
  };
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
