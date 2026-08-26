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
  AssistantFeedbackController,
} = require('../dist/assistant/feedback/assistant-feedback.controller.js');

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
    createCandidate('11111111-1111-4111-8111-111111111111', 20_000_000),
    createCandidate('22222222-2222-4222-8222-222222222222', 24_000_000),
  ];
  const answer = {
    kind: 'SEARCH_RESULTS',
    exactResults: [{
      unitId: candidates[0].unitId,
      title: 'ЖК Аудит',
      subtitle: '2-комнатная',
      priceRub: 20_000_000,
      availabilityLabel: 'В продаже',
      freshnessLabel: 'обновлено менее часа назад',
      isStale: false,
      href: `/objects/audit/lots/${candidates[0].unitId}`,
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
    selectedEvidence: [candidates[0]],
    telemetry,
    latencyMs: 16_000,
    now: new Date('2026-08-26T12:00:00.000Z'),
  });

  assert.equal(audit.schemaVersion, 1);
  assert.deepEqual(audit.appliedFilters, emptyFilters);
  assert.deepEqual(audit.candidateSet.map(({ evidenceId }) => evidenceId), candidates.map(({ unitId }) => unitId));
  assert.deepEqual(audit.rankingDecisions.map(({ outcome }) => outcome), ['PRIMARY', 'REJECTED']);
  assert.deepEqual(audit.evidenceRevisions, [{
    kind: 'PLATFORMA_FEED_UNIT',
    evidenceId: candidates[0].unitId,
    revisionId: candidates[0].unitId,
    observedAt: candidates[0].updatedAt,
  }]);
  assert.deepEqual([...audit.qualityFlags].sort(), ['LATENCY_BREACH', 'MODEL_FALLBACK']);
  assert.equal(JSON.stringify(audit).includes('citation'), false);
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
