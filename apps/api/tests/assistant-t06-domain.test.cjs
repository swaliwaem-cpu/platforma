require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { PATH_METADATA } = require('@nestjs/common/constants');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const {
  AssistantAuditController,
} = require('../dist/assistant/audit/assistant-audit.controller.js');
const {
  buildAssistantRunAudit,
} = require('../dist/assistant/audit/assistant-run-audit.js');
const {
  AssistantPlannerError,
  AssistantQueryPlanner,
} = require('../dist/assistant/assistant-query-planner.js');
const {
  AssistantFeedbackController,
} = require('../dist/assistant/feedback/assistant-feedback.controller.js');
const {
  AssistantGeoProviderError,
  LocationIqGeoProvider,
} = require('../dist/assistant/geo/assistant-geo-provider.js');
const {
  AssistantGeoProviderPolicyService,
} = require('../dist/assistant/geo/assistant-geo-provider-policy.service.js');
const {
  AssistantUsageBudgetError,
} = require('../dist/assistant/operations/assistant-usage-budget.service.js');

const emptyFilters = {
  budgetMinRub: null,
  budgetMaxRub: 25_000_000,
  rooms: [2],
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

test('Assistant T06 audit uses an independent additive permission while feedback stays on the user boundary', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, AssistantAuditController), 'assistant/audit');
  assert.deepEqual(Reflect.getMetadata(PERMISSIONS_KEY, AssistantAuditController), [
    'assistant:audit:read',
  ]);
  assert.equal(Reflect.getMetadata(PATH_METADATA, AssistantFeedbackController), 'assistant/messages');
  assert.deepEqual(Reflect.getMetadata(PERMISSIONS_KEY, AssistantFeedbackController), [
    'objects:read',
  ]);
});

test('Assistant T06 audit is assembled deterministically from selected evidence without citation generation', () => {
  const intent = {
    taskType: 'SEARCH',
    comparisonTargets: [],
    hardFilters: emptyFilters,
    softPreferences: { ...emptyFilters, budgetMaxRub: null },
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
  const candidates = [
    createCandidate('11111111-1111-4111-8111-111111111111', 24_000_000),
    createCandidate('22222222-2222-4222-8222-222222222222', 20_000_000),
    createCandidate('33333333-3333-4333-8333-333333333333', 30_000_000),
  ];
  const answer = {
    kind: 'SEARCH_RESULTS',
    exactResults: [{
      unitId: candidates[1].unitId,
      title: 'ЖК Аудит',
      subtitle: '2-комнатная',
      priceRub: 20_000_000,
      availabilityLabel: 'В продаже',
      freshnessLabel: 'обновлено менее часа назад',
      isStale: false,
      href: `/objects/audit/lots/${candidates[1].unitId}`,
      facts: [],
      pdfs: [],
      deviations: [],
    }],
    alternatives: [],
  };
  const telemetry = [{
    provider: 'fake',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    outcome: 'ACCEPTED',
    errorCode: null,
    isFallback: true,
    requestId: null,
    responseId: null,
    httpStatus: 200,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    totalTokens: 17,
    durationMs: 40,
  }];

  const audit = buildAssistantRunAudit({
    intent,
    answer,
    candidateEvidence: candidates,
    selectedEvidence: [candidates[1]],
    telemetry,
    latencyMs: 16_000,
    now: new Date('2026-08-26T12:00:00.000Z'),
  });

  assert.equal(audit.schemaVersion, 1);
  assert.deepEqual(audit.appliedFilters, emptyFilters);
  assert.deepEqual(audit.candidateSet.map(({ evidenceId }) => evidenceId), [
    candidates[1].unitId,
    candidates[0].unitId,
    candidates[2].unitId,
  ]);
  assert.deepEqual(audit.candidateSet.map(({ candidateRank }) => candidateRank), [1, 2, null]);
  assert.deepEqual(audit.candidateSet.map(({ rankingPool }) => rankingPool), ['EXACT', 'EXACT', 'REJECTED']);
  assert.equal(audit.candidateSet[0].rooms, 2);
  assert.equal(audit.candidateSet[0].area, 60);
  assert.deepEqual(audit.rankingDecisions.map(({ outcome }) => outcome), ['PRIMARY', 'REJECTED', 'REJECTED']);
  assert.deepEqual(audit.rankingDecisions.map(({ candidateRank }) => candidateRank), [1, 2, null]);
  assert.equal(audit.rankingDecisions[2].answerRank, null);
  assert.match(audit.rankingDecisions[2].reason, /HARD_FILTER_MISMATCH/u);
  assert.deepEqual(audit.evidenceRevisions, [{
    kind: 'PLATFORMA_FEED_UNIT',
    evidenceId: candidates[1].unitId,
    revisionId: candidates[1].unitId,
    observedAt: candidates[1].updatedAt,
  }]);
  assert.deepEqual([...audit.qualityFlags].sort(), ['LATENCY_BREACH', 'MODEL_FALLBACK']);
  assert.equal(JSON.stringify(audit).includes('citation'), false);
});

test('Assistant T06 audit treats expanded exact results as primary ranks 4 through 8', () => {
  const intent = {
    taskType: 'SEARCH',
    comparisonTargets: [],
    hardFilters: emptyFilters,
    softPreferences: { ...emptyFilters, budgetMaxRub: null },
    requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
    needsClarification: false,
    clarificationQuestion: null,
  };
  const candidates = Array.from({ length: 8 }, (_, index) => createCandidate(
    `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    20_000_000 + index * 100_000,
  ));
  candidates.at(-1).updatedAt = '2026-08-23T12:00:00.000Z';
  const cards = candidates.map((candidate, index) => ({
    unitId: candidate.unitId,
    title: 'ЖК Аудит',
    subtitle: '2-комнатная',
    priceRub: candidate.priceRub,
    availabilityLabel: 'В продаже',
    freshnessLabel: index === candidates.length - 1 ? 'Свежесть неизвестна' : 'Обновлено сегодня',
    isStale: false,
    href: index === candidates.length - 1
      ? '/broken'
      : `/objects/audit/lots/${candidate.unitId}`,
    facts: [],
    pdfs: [],
    deviations: [],
  }));
  const audit = buildAssistantRunAudit({
    intent,
    answer: {
      kind: 'SEARCH_RESULTS',
      totalExactResults: 8,
      exactResults: cards.slice(0, 3),
      additionalExactResults: cards.slice(3),
      alternatives: [],
    },
    candidateEvidence: candidates,
    selectedEvidence: candidates,
    telemetry: [],
    latencyMs: 0,
    now: new Date('2026-08-26T12:00:00.000Z'),
  });

  assert.deepEqual(audit.rankingDecisions.map(({ outcome }) => outcome), Array(8).fill('PRIMARY'));
  assert.deepEqual(audit.rankingDecisions.map(({ answerRank }) => answerRank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(audit.qualityFlags, ['STALE_PRICE_UNLABELED', 'BROKEN_LINK']);
});

test('Assistant T06 planner completes safe telemetry when downstream validation unexpectedly fails', async () => {
  const recorded = [];
  const planner = new AssistantQueryPlanner({
    async plan() {
      return {
        output: {
          taskType: 'SEARCH',
          comparisonTargets: [],
          hardFilters: emptyFilters,
          softPreferences: { ...emptyFilters, budgetMaxRub: null },
          requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
          needsClarification: false,
          clarificationQuestion: null,
        },
        provider: 'openai',
        requestId: 'safe-request-id',
        responseId: 'safe-response-id',
        httpStatus: 200,
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
      };
    },
  }, {
    async beforeAttempt() { return { reservation: true }; },
    async afterAttempt(_reservation, telemetry) { recorded.push(telemetry); },
  });

  await assert.rejects(
    planner.planWithValidation(
      { messages: ['Найди квартиру до 25 млн рублей'], context: null },
      async () => { throw new Error('sensitive downstream detail'); },
    ),
    (error) => error instanceof AssistantPlannerError
      && error.code === 'ASSISTANT_PLANNER_PIPELINE_FAILED'
      && error.telemetry.length === 1,
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].outcome, 'LOCAL_VALIDATION_FAILED');
  assert.equal(recorded[0].errorCode, 'ASSISTANT_PLANNER_PIPELINE_FAILED');
  assert.equal(recorded[0].totalTokens, 17);
  assert.equal(JSON.stringify(recorded).includes('sensitive downstream detail'), false);
});

test('Assistant T06 geo budgets and operation telemetry count every physical retry', async () => {
  const environment = {
    ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    LOCATIONIQ_API_KEY: 'test-key',
    LOCATIONIQ_API_URL: 'https://provider.example/v1/search',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '1',
    ASSISTANT_GEO_PROVIDER_RPS: '20',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '10',
    ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '10',
    ASSISTANT_GEO_CACHE_TTL_SECONDS: '60',
  };
  const request = { query: 'Плотинка', locale: 'ru', country: 'ru', viewbox: null };
  let fetchCalls = 0;
  const completed = [];
  const budgets = {
    async reserve() {
      return {
        provider: 'locationiq',
        model: 'locationiq',
        minuteStartedAt: new Date('2026-08-26T10:00:00.000Z'),
        dayStartedAt: new Date('2026-08-26T00:00:00.000Z'),
      };
    },
    async complete(input) { completed.push(input.outcome); },
  };
  const provider = new LocationIqGeoProvider(environment, async () => {
    fetchCalls += 1;
    return fetchCalls === 1
      ? new Response('unavailable', { status: 503 })
      : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {});
  const policy = new AssistantGeoProviderPolicyService(
    { $queryRaw: async () => { throw new Error('legacy budget must not run'); } },
    provider,
    environment,
    () => new Date('2026-08-26T10:00:00.000Z'),
    async () => {},
    budgets,
  );

  const result = await policy.searchWithTelemetry(request);
  assert.equal(result.providerCallCount, 2);
  assert.equal(fetchCalls, 2);
  assert.deepEqual(completed, ['ERROR', 'SUCCESS']);

  let reservations = 0;
  fetchCalls = 0;
  const exhaustedProvider = new LocationIqGeoProvider(environment, async () => {
    fetchCalls += 1;
    return new Response('unavailable', { status: 503 });
  }, async () => {});
  const exhaustedPolicy = new AssistantGeoProviderPolicyService(
    { $queryRaw: async () => { throw new Error('legacy budget must not run'); } },
    exhaustedProvider,
    environment,
    () => new Date('2026-08-26T10:00:00.000Z'),
    async () => {},
    {
      async reserve() {
        reservations += 1;
        if (reservations === 2) {
          throw new AssistantUsageBudgetError('ASSISTANT_GEO_PROVIDER_MINUTE_BUDGET_EXHAUSTED', 'locationiq');
        }
        return {
          provider: 'locationiq', model: 'locationiq',
          minuteStartedAt: new Date('2026-08-26T10:00:00.000Z'),
          dayStartedAt: new Date('2026-08-26T00:00:00.000Z'),
        };
      },
      async complete() {},
    },
  );
  await assert.rejects(
    exhaustedPolicy.searchWithTelemetry(request),
    (error) => error instanceof AssistantGeoProviderError
      && error.code === 'ASSISTANT_GEO_PROVIDER_MINUTE_BUDGET_EXHAUSTED'
      && error.providerCallCount === 1,
  );
  assert.equal(fetchCalls, 1);
});

function createCandidate(unitId, priceRub) {
  return {
    evidenceType: 'PLATFORMA_FEED_UNIT',
    unitId,
    objectId: '33333333-3333-4333-8333-333333333333',
    objectType: 'RESIDENTIAL',
    objectTitle: 'ЖК Аудит',
    objectSlug: 'audit',
    lotTitle: '2-комнатная',
    priceRub,
    availability: 'AVAILABLE',
    rooms: 2,
    district: null,
    metros: [],
    developer: null,
    completionYear: null,
    completionQuarter: null,
    propertyClass: null,
    area: 60,
    floor: 8,
    latitude: null,
    longitude: null,
    distanceMeters: null,
    updatedAt: '2026-08-26T11:45:00.000Z',
    pdfs: [],
    deviations: [],
  };
}
