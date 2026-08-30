require('reflect-metadata');

const assert = require('node:assert/strict');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const {
  assistantEvalCategories,
  assistantEvalZeroToleranceViolations,
  computeAssistantEvalDatasetSha256,
  evaluateAssistantEvalArtifact,
  loadAssistantEvalDataset,
  scoreAssistantEval,
} = require('../dist/assistant/eval/assistant-eval.js');
const {
  assessAssistantRolloutTransition,
  AssistantExternalConnectorsGuard,
  getAssistantRuntimeConfig,
  isAssistantEnabledForActor,
} = require('../dist/assistant/assistant-runtime-config.js');
const {
  AssistantQueryPlanner,
  extractAssistantExplicitHardFilters,
} = require('../dist/assistant/assistant-query-planner.js');
const {
  AssistantFakePlannerGateway,
} = require('../dist/assistant/assistant-planner-gateway.js');
const {
  AssistantGeoProviderError,
} = require('../dist/assistant/geo/assistant-geo-provider.js');
const {
  AssistantGeoProviderPolicyService,
} = require('../dist/assistant/geo/assistant-geo-provider-policy.service.js');
const {
  AssistantSourcesController,
} = require('../dist/assistant/sources/assistant-sources.controller.js');
const {
  isAssistantSourceWorkerRunnable,
} = require('../dist/assistant/sources/assistant-source.worker.js');
const {
  assessAssistantRolloutStageRecord,
  assessAssistantPilotCohort,
  assessAssistantPilotCohortAgainstApproval,
  assessAssistantRolloutObservation,
  assessAssistantProviderBudgetContract,
  collectAssistantProviderComparisonRunIds,
  assessAssistantSourceHealth,
  countAssistantRolloutCriticalErrors,
  readAssistantRolloutBudgetReadiness,
  computeAssistantRolloutApprovalDigest,
} = require('../dist/assistant/rollout/assistant-rollout-preflight.js');
const {
  readAssistantPaidProviderReadiness,
} = require('../dist/assistant/operations/assistant-paid-readiness.js');

const datasetPath = resolve(
  __dirname,
  'fixtures/assistant/assistant-eval-v1.json',
);

test('Assistant T07 eval v1 freezes 200 unique cases, coverage and quality/latency/cost thresholds', () => {
  const rawDataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const dataset = loadAssistantEvalDataset(rawDataset);

  assert.equal(dataset.version, 'assistant-eval-v1');
  assert.equal(dataset.cases.length, 200);
  assert.equal(new Set(dataset.cases.map(({ id }) => id)).size, 200);
  assert.deepEqual(
    [...new Set(dataset.cases.map(({ category }) => category))].sort(),
    [...assistantEvalCategories].sort(),
  );
  for (const category of assistantEvalCategories) {
    assert.equal(dataset.cases.some((item) => item.category === category), true);
  }
  assert.deepEqual(
    dataset.zeroTolerance,
    assistantEvalZeroToleranceViolations,
  );
  assert.deepEqual(dataset.thresholds, {
    minimumOverallPassRate: 0.9,
    minimumCategoryPassRate: 0.8,
    minimumAverageQualityScore: 0.85,
    maximumP95LatencyMs: 15_000,
    maximumAverageModelAttempts: 1.1,
    maximumAverageTotalTokens: 2_500,
    maximumAverageGeoProviderCalls: 0.25,
  });
  assert.equal(
    computeAssistantEvalDatasetSha256(dataset),
    'dc1c1ca5b52df1a440553b9879e8b10ecebe5c286a10c86d667957132cfcf8aa',
  );
  assert.equal(
    extractAssistantExplicitHardFilters(['Найди квартиру, этаж от 4.']).floorMin,
    4,
  );
  assert.deepEqual(
    extractAssistantExplicitHardFilters(['Найди квартиру до 21 млн рублей.']),
    { budgetMaxRub: 21_000_000, objectType: 'RESIDENTIAL' },
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру в радиусе 2 км от Белорусского вокзала.',
    ]).developer,
    undefined,
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру в радиусе 2 км от метро Спортивная.',
    ]).metro,
    undefined,
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру в радиусе 2 км от станции метро Спортивная.',
    ]).metro,
    undefined,
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру радиусом 2 км от Белорусского вокзала.',
    ]).developer,
    undefined,
  );
  const repeatedGeoFilters = extractAssistantExplicitHardFilters([
      'Найди в радиусе 2 км от Белорусского вокзала.',
      'Найди в радиусе 3 км от метро Спортивная.',
    ]);
  assert.equal(repeatedGeoFilters.metro, undefined);
  assert.equal(repeatedGeoFilters.developer, undefined);
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру в радиусе 2 км от Павелецкой Плаза до 20 млн рублей.',
    ]).budgetMaxRub,
    20_000_000,
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру в радиусе 2 км от Павелецкой Плаза от застройщика ПИК.',
    ]).developer,
    'ПИК',
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру в радиусе 2 км от Павелецкой Плаза у метро Тульская.',
    ]).metro,
    'Тульская',
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди квартиру в радиусе 2 км от Павелецкой Плаза в районе Даниловский.',
    ]).district,
    'Даниловский',
  );
  assert.equal(
    extractAssistantExplicitHardFilters([
      'Найди 2-комнатную квартиру до 4 млн рублей в районе Хамовники площадью от 181 м² в готовом доме.',
    ]).district,
    'Хамовники',
  );
  rawDataset.cases[0].query += ' drift';
  assert.throws(
    () => loadAssistantEvalDataset(rawDataset),
    /ASSISTANT_EVAL_DATASET_SHA256_INVALID/u,
  );
});

test('Assistant T07 frozen standalone queries reproduce their canonical persisted intents', async () => {
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(datasetPath, 'utf8')));
  const planner = new AssistantQueryPlanner(new AssistantFakePlannerGateway());
  for (const item of dataset.cases.filter(({ expected }) => expected.expectedIntent)) {
    const geo = item.expected.expectedGeo ? {
      hasGeoConstraint: true,
      kind: 'POINT',
      mode: 'NEAR',
      label: item.expected.expectedGeo.anchorLabel,
      distanceMeters: item.expected.expectedGeo.radiusMeters,
    } : null;
    const planned = await planner.plan({
      messages: [item.query],
      context: geo ? { pageContext: null, geo } : null,
    });
    assert.deepEqual(planned.intent, item.expected.expectedIntent, item.id);
  }
});

test('Assistant T07 eval derives verdicts from persisted runs and blocks every zero-tolerance violation', () => {
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(datasetPath, 'utf8')));
  const now = new Date('2026-08-26T12:00:00.000Z');
  const artifact = perfectEvalArtifact(dataset, now);
  const runRecords = perfectEvalRunRecords(dataset, now);
  const report = evaluateAssistantEvalArtifact(dataset, artifact, runRecords, now);
  const passed = scoreAssistantEval(dataset, report);

  assert.equal(passed.passed, true);
  assert.deepEqual(passed.gates.filter(({ passed: gatePassed }) => !gatePassed), []);
  assert.throws(
    () => evaluateAssistantEvalArtifact(dataset, {
      datasetVersion: dataset.version,
      results: report.results,
    }, runRecords, now),
    /ASSISTANT_EVAL_ARTIFACT_INVALID/u,
  );

  assert.equal(report.provenance.length, 200);
  const changedRecords = structuredClone(runRecords);
  changedRecords[0].answer.content = 'changed persisted answer';
  const changedReport = evaluateAssistantEvalArtifact(dataset, artifact, changedRecords, now);
  assert.notEqual(changedReport.provenance[0].answerDigest, report.provenance[0].answerDigest);
  const missingTelemetry = structuredClone(runRecords);
  missingTelemetry[0].telemetry = [];
  assert.throws(
    () => evaluateAssistantEvalArtifact(dataset, artifact, missingTelemetry, now),
    /ASSISTANT_EVAL_PERSISTED_TELEMETRY_INVALID/u,
  );
  const invalidTelemetry = structuredClone(runRecords);
  invalidTelemetry[0].telemetry = [{ outcome: 'UNKNOWN', totalTokens: 0 }];
  assert.throws(
    () => evaluateAssistantEvalArtifact(dataset, artifact, invalidTelemetry, now),
    /ASSISTANT_EVAL_PERSISTED_TELEMETRY_INVALID/u,
  );
  const negativeTelemetry = structuredClone(runRecords);
  negativeTelemetry[0].telemetry = [{ outcome: 'ACCEPTED', totalTokens: -1 }];
  assert.throws(
    () => evaluateAssistantEvalArtifact(dataset, artifact, negativeTelemetry, now),
    /ASSISTANT_EVAL_PERSISTED_TELEMETRY_INVALID/u,
  );
  const inventedKnowledgeFact = structuredClone(runRecords);
  const mortgageIndex = dataset.cases.findIndex(({ category }) => category === 'MORTGAGE_INSTALLMENT');
  inventedKnowledgeFact[mortgageIndex].answer.facts[0].value = 'Неподтверждённое значение';
  const inventedKnowledgeReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    inventedKnowledgeFact,
    now,
  );
  assert.deepEqual(inventedKnowledgeReport.results[mortgageIndex].violations, [
    'INVENTED_PRICE_OR_AVAILABILITY',
  ]);
  const wrongKnowledgeSubject = structuredClone(runRecords);
  const knowledgeFactualIndex = dataset.cases.findIndex(({ category }) => category === 'FACTUAL');
  wrongKnowledgeSubject[knowledgeFactualIndex].evidence[0].kind = 'INFRASTRUCTURE';
  wrongKnowledgeSubject[knowledgeFactualIndex].evidence[0].projectKey = 'other-project';
  wrongKnowledgeSubject[knowledgeFactualIndex].audit.candidateSet[0].factKind = 'INFRASTRUCTURE';
  wrongKnowledgeSubject[knowledgeFactualIndex].audit.candidateSet[0].kind = 'INFRASTRUCTURE';
  wrongKnowledgeSubject[knowledgeFactualIndex].audit.candidateSet[0].projectKey = 'other-project';
  const wrongKnowledgeSubjectReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    wrongKnowledgeSubject,
    now,
  );
  assert.equal(
    wrongKnowledgeSubjectReport.results[knowledgeFactualIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  const inventedClarificationContent = structuredClone(runRecords);
  const clarificationIndex = dataset.cases.findIndex(({ category }) => category === 'CLARIFICATION');
  inventedClarificationContent[clarificationIndex].answer.content =
    'Есть доступная квартира за 5 000 000 ₽';
  const inventedClarificationReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    inventedClarificationContent,
    now,
  );
  assert.equal(
    inventedClarificationReport.results[clarificationIndex].violations.includes(
      'INVENTED_PRICE_OR_AVAILABILITY',
    ),
    true,
  );
  const directAvailabilityClaim = structuredClone(runRecords);
  directAvailabilityClaim[clarificationIndex].answer.content = 'Квартира доступна. Лот в продаже.';
  const directAvailabilityReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    directAvailabilityClaim,
    now,
  );
  assert.equal(
    directAvailabilityReport.results[clarificationIndex].violations.includes(
      'INVENTED_PRICE_OR_AVAILABILITY',
    ),
    true,
  );
  const inventedDifferentLotClaim = structuredClone(runRecords);
  const structuredSearchIndex = dataset.cases.findIndex(({ category }) => (
    category === 'STRUCTURED_SEARCH'
  ));
  inventedDifferentLotClaim[structuredSearchIndex].answer.content =
    'Лот 999 доступен за 20 млн ₽.';
  const inventedDifferentLotReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    inventedDifferentLotClaim,
    now,
  );
  assert.equal(
    inventedDifferentLotReport.results[structuredSearchIndex].violations.includes(
      'INVENTED_PRICE_OR_AVAILABILITY',
    ),
    true,
  );
  const plainNumericPriceClaim = structuredClone(runRecords);
  plainNumericPriceClaim[clarificationIndex].answer.content = 'Цена квартиры — 5000000.';
  const plainNumericPriceReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    plainNumericPriceClaim,
    now,
  );
  assert.equal(
    plainNumericPriceReport.results[clarificationIndex].violations.includes(
      'INVENTED_PRICE_OR_AVAILABILITY',
    ),
    true,
  );
  const fullWordPriceClaim = structuredClone(runRecords);
  fullWordPriceClaim[clarificationIndex].answer.content =
    'Цена объекта — 5 миллионов рублей.';
  const fullWordPriceReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    fullWordPriceClaim,
    now,
  );
  assert.equal(
    fullWordPriceReport.results[clarificationIndex].violations.includes(
      'INVENTED_PRICE_OR_AVAILABILITY',
    ),
    true,
  );
  const negatedAvailabilityClaim = structuredClone(runRecords);
  negatedAvailabilityClaim[clarificationIndex].answer.content =
    'Квартира недоступна. Лот не в продаже.';
  negatedAvailabilityClaim[clarificationIndex].intent.clarificationQuestion =
    negatedAvailabilityClaim[clarificationIndex].answer.content;
  const negatedAvailabilityReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    negatedAvailabilityClaim,
    now,
  );
  assert.equal(
    negatedAvailabilityReport.results[clarificationIndex].violations.includes(
      'INVENTED_PRICE_OR_AVAILABILITY',
    ),
    false,
  );
  const unrelatedMortgagePromotion = structuredClone(runRecords);
  unrelatedMortgagePromotion[mortgageIndex].answer.facts[0].label = 'Парковочная акция';
  unrelatedMortgagePromotion[mortgageIndex].answer.facts[0].value = 'Скидка на машиноместо';
  unrelatedMortgagePromotion[mortgageIndex].evidence[0].label = 'Парковочная акция';
  unrelatedMortgagePromotion[mortgageIndex].evidence[0].value = 'Скидка на машиноместо';
  unrelatedMortgagePromotion[mortgageIndex].audit.candidateSet[0].label = 'Парковочная акция';
  unrelatedMortgagePromotion[mortgageIndex].audit.candidateSet[0].value = 'Скидка на машиноместо';
  const unrelatedMortgagePromotionReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    unrelatedMortgagePromotion,
    now,
  );
  assert.equal(
    unrelatedMortgagePromotionReport.results[mortgageIndex].violations.includes(
      'HARD_FILTER_VIOLATION',
    ),
    true,
  );
  const unsupportedFreeTextLink = structuredClone(runRecords);
  unsupportedFreeTextLink[knowledgeFactualIndex].answer.content =
    'Подробности: https://untrusted.example/invented-lot';
  const unsupportedFreeTextLinkReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    unsupportedFreeTextLink,
    now,
  );
  assert.equal(
    unsupportedFreeTextLinkReport.results[knowledgeFactualIndex].violations.includes('UNSUPPORTED_LINK'),
    true,
  );
  const falseAvailability = structuredClone(runRecords);
  const searchIndex = dataset.cases.findIndex(({ category }) => category === 'STRUCTURED_SEARCH');
  const expandedStructuredSearch = structuredClone(runRecords);
  const expandedSearchRun = expandedStructuredSearch[searchIndex];
  const originalSearchResult = expandedSearchRun.answer.exactResults[0];
  const originalSearchEvidence = expandedSearchRun.evidence[0];
  const extraSearchResults = Array.from({ length: 7 }, (_, index) => {
    const unitId = `23000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return {
      ...originalSearchResult,
      unitId,
      href: `/objects/eval-project/lots/${unitId}`,
    };
  });
  const extraSearchEvidence = extraSearchResults.map((result, index) => ({
    ...originalSearchEvidence,
    unitId: result.unitId,
    unitExternalId: `eval-expanded-${index + 1}`,
    lotTitle: result.title,
  }));
  expandedSearchRun.answer.totalExactResults = 8;
  expandedSearchRun.answer.exactResults.push(...extraSearchResults.slice(0, 2));
  expandedSearchRun.answer.additionalExactResults = extraSearchResults.slice(2);
  expandedSearchRun.evidence.push(...extraSearchEvidence);
  expandedSearchRun.audit.candidateSet.push(...extraSearchEvidence.map((evidence) => ({
    evidenceId: evidence.unitId,
    ...evidence,
  })));
  expandedSearchRun.audit.rankingDecisions.push(...extraSearchEvidence.map((evidence) => ({
    evidenceId: evidence.unitId,
    outcome: 'PRIMARY',
  })));
  expandedSearchRun.audit.evidenceRevisions.push(...extraSearchEvidence.map((evidence) => ({
    evidenceId: evidence.unitId,
  })));
  const expandedStructuredSearchReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    expandedStructuredSearch,
    now,
  );
  assert.equal(dataset.cases[searchIndex].expected.maximumPrimaryResults, 3);
  assert.equal(expandedStructuredSearchReport.results[searchIndex].passed, true);

  falseAvailability[searchIndex].answer.exactResults[0].availabilityLabel = 'Продано';
  const falseAvailabilityReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    falseAvailability,
    now,
  );
  assert.deepEqual(falseAvailabilityReport.results[searchIndex].violations, [
    'INVENTED_PRICE_OR_AVAILABILITY',
  ]);
  const emptyStructuredSearch = structuredClone(runRecords);
  emptyStructuredSearch[searchIndex].answer.exactResults = [];
  emptyStructuredSearch[searchIndex].evidence = [];
  emptyStructuredSearch[searchIndex].audit.candidateSet = [];
  emptyStructuredSearch[searchIndex].audit.rankingDecisions = [];
  const emptyStructuredSearchReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    emptyStructuredSearch,
    now,
  );
  assert.equal(emptyStructuredSearchReport.results[searchIndex].passed, false);
  const persistedHardFilterViolation = structuredClone(runRecords);
  persistedHardFilterViolation[searchIndex].intent.hardFilters.budgetMaxRub = 10_000_000;
  const hardFilterReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    persistedHardFilterViolation,
    now,
  );
  assert.equal(hardFilterReport.results[searchIndex].violations.includes('HARD_FILTER_VIOLATION'), true);
  const unexpectedHardFilter = structuredClone(runRecords);
  unexpectedHardFilter[searchIndex].intent.hardFilters.floorMax = 21;
  const unexpectedHardFilterReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    unexpectedHardFilter,
    now,
  );
  assert.equal(
    unexpectedHardFilterReport.results[searchIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  const boundedAlternative = structuredClone(runRecords);
  const alternativeRecord = boundedAlternative[searchIndex];
  const alternativeCard = alternativeRecord.answer.exactResults.shift();
  alternativeCard.priceRub = alternativeRecord.intent.hardFilters.budgetMaxRub + 1_000_000;
  alternativeCard.deviations = [{ type: 'BUDGET', label: 'Бюджет выше на 1 000 000 ₽' }];
  alternativeRecord.answer.alternatives = [alternativeCard];
  alternativeRecord.evidence[0].priceRub = alternativeCard.priceRub;
  alternativeRecord.evidence[0].deviations = alternativeCard.deviations;
  alternativeRecord.audit.rankingDecisions[0].outcome = 'ALTERNATIVE';
  const alternativeReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    boundedAlternative,
    now,
  );
  assert.equal(alternativeReport.results[searchIndex].violations.includes('HARD_FILTER_VIOLATION'), false);
  const overBudgetAlternative = structuredClone(boundedAlternative);
  const maximumBudget = overBudgetAlternative[searchIndex].intent.hardFilters.budgetMaxRub;
  overBudgetAlternative[searchIndex].answer.alternatives[0].priceRub = maximumBudget + 8_000_000;
  overBudgetAlternative[searchIndex].evidence[0].priceRub = maximumBudget + 8_000_000;
  overBudgetAlternative[searchIndex].answer.alternatives[0].deviations = [
    { type: 'BUDGET', label: 'Бюджет выше на 8 млн ₽' },
  ];
  overBudgetAlternative[searchIndex].evidence[0].deviations = [
    { type: 'BUDGET', label: 'Бюджет выше на 8 млн ₽' },
  ];
  const overBudgetReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    overBudgetAlternative,
    now,
  );
  assert.equal(overBudgetReport.results[searchIndex].violations.includes('HARD_FILTER_VIOLATION'), true);
  const counterfeitAlternative = structuredClone(boundedAlternative);
  counterfeitAlternative[searchIndex].answer.alternatives[0].priceRub = 20_000_000;
  counterfeitAlternative[searchIndex].evidence[0].priceRub = 20_000_000;
  const counterfeitAlternativeReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    counterfeitAlternative,
    now,
  );
  assert.equal(
    counterfeitAlternativeReport.results[searchIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  const missingGeo = structuredClone(runRecords);
  const geoIndex = dataset.cases.findIndex(({ category }) => category === 'GEOSEARCH');
  delete missingGeo[geoIndex].answer.geo;
  const missingGeoReport = evaluateAssistantEvalArtifact(dataset, artifact, missingGeo, now);
  assert.equal(missingGeoReport.results[geoIndex].violations.includes('HARD_FILTER_VIOLATION'), true);
  const wrongGeoAnchor = structuredClone(runRecords);
  wrongGeoAnchor[geoIndex].answer.geo.anchor.latitude += 0.1;
  const wrongGeoReport = evaluateAssistantEvalArtifact(dataset, artifact, wrongGeoAnchor, now);
  assert.equal(wrongGeoReport.results[geoIndex].violations.includes('HARD_FILTER_VIOLATION'), true);
  const canonicalGeo = structuredClone(runRecords);
  const expectedGeo = dataset.cases[geoIndex].expected.expectedGeo;
  const legacyMarkers = canonicalGeo[geoIndex].answer.geo.markers;
  canonicalGeo[geoIndex].answer.geo = {
    kind: 'POINT',
    mode: 'NEAR',
    label: expectedGeo.anchorLabel,
    point: { latitude: expectedGeo.latitude, longitude: expectedGeo.longitude },
    distanceMeters: expectedGeo.radiusMeters,
    source: 'LANDMARK',
    referenceGeometry: {
      type: 'Point',
      coordinates: [expectedGeo.longitude, expectedGeo.latitude],
    },
    searchArea: {
      type: 'Polygon',
      coordinates: [[
        [expectedGeo.longitude - 0.01, expectedGeo.latitude - 0.01],
        [expectedGeo.longitude + 0.01, expectedGeo.latitude - 0.01],
        [expectedGeo.longitude + 0.01, expectedGeo.latitude + 0.01],
        [expectedGeo.longitude - 0.01, expectedGeo.latitude + 0.01],
        [expectedGeo.longitude - 0.01, expectedGeo.latitude - 0.01],
      ]],
    },
    markers: legacyMarkers,
  };
  canonicalGeo[geoIndex].geoContext = {
    kind: 'POINT',
    mode: 'NEAR',
    label: expectedGeo.anchorLabel,
    point: { latitude: expectedGeo.latitude, longitude: expectedGeo.longitude },
    distanceMeters: expectedGeo.radiusMeters,
    source: 'LANDMARK',
  };
  const canonicalGeoReport = evaluateAssistantEvalArtifact(dataset, artifact, canonicalGeo, now);
  assert.equal(
    canonicalGeoReport.results[geoIndex].violations.includes('HARD_FILTER_VIOLATION'),
    false,
  );
  const mismatchedCanonicalGeometry = structuredClone(canonicalGeo);
  mismatchedCanonicalGeometry[geoIndex].answer.geo.referenceGeometry.coordinates[1] += 0.1;
  const mismatchedCanonicalGeometryReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    mismatchedCanonicalGeometry,
    now,
  );
  assert.equal(
    mismatchedCanonicalGeometryReport.results[geoIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  const forgedGeoDistance = structuredClone(runRecords);
  forgedGeoDistance[geoIndex].evidence[0].latitude += 0.1;
  const forgedGeoReport = evaluateAssistantEvalArtifact(dataset, artifact, forgedGeoDistance, now);
  assert.equal(forgedGeoReport.results[geoIndex].violations.includes('HARD_FILTER_VIOLATION'), true);
  const groupedComparison = structuredClone(runRecords);
  const groupedComparisonIndex = dataset.cases.findIndex(({ category }) => category === 'COMPARISON');
  const groupedRun = groupedComparison[groupedComparisonIndex];
  const [firstComparisonCard, secondComparisonCard] = groupedRun.answer.exactResults;
  const [firstComparisonTarget, secondComparisonTarget] = groupedRun.intent.comparisonTargets;
  groupedRun.answer = {
    kind: 'COMPARISON_RESULTS',
    content: 'Сравнил подтверждённые предложения отдельно по каждому выбранному ЖК.',
    groups: [{
      target: firstComparisonTarget,
      status: 'MATCHED',
      totalExactResults: 1,
      exactResults: [firstComparisonCard],
      additionalExactResults: [],
      summary: { minimumPriceRub: firstComparisonCard.priceRub, completion: ['3 кв. 2027'], metros: ['Спортивная'] },
    }, {
      target: secondComparisonTarget,
      status: 'MATCHED',
      totalExactResults: 1,
      exactResults: [secondComparisonCard],
      additionalExactResults: [],
      summary: { minimumPriceRub: secondComparisonCard.priceRub, completion: ['3 кв. 2027'], metros: ['Спортивная'] },
    }],
  };
  const groupedComparisonReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    groupedComparison,
    now,
  );
  assert.equal(groupedComparisonReport.results[groupedComparisonIndex].passed, true);
  const groupedComparisonWithoutMinimum = structuredClone(groupedComparison);
  groupedComparisonWithoutMinimum[groupedComparisonIndex]
    .answer.groups[0].summary.minimumPriceRub = null;
  assert.throws(() => evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    groupedComparisonWithoutMinimum,
    now,
  ), /ASSISTANT_EVAL_PERSISTED_ANSWER_INVALID/u);
  const partialGroupedComparison = structuredClone(groupedComparison);
  const partialGroupedRun = partialGroupedComparison[groupedComparisonIndex];
  const removedCard = partialGroupedRun.answer.groups[1].exactResults[0];
  partialGroupedRun.answer.groups[1] = {
    target: partialGroupedRun.answer.groups[1].target,
    status: 'NO_MATCH',
    totalExactResults: 0,
    exactResults: [],
    additionalExactResults: [],
    summary: { minimumPriceRub: null, completion: [], metros: [] },
  };
  partialGroupedRun.evidence = partialGroupedRun.evidence.filter(({ unitId }) => unitId !== removedCard.unitId);
  partialGroupedRun.audit.candidateSet = partialGroupedRun.audit.candidateSet.filter(
    ({ evidenceId }) => evidenceId !== removedCard.unitId,
  );
  partialGroupedRun.audit.rankingDecisions = partialGroupedRun.audit.rankingDecisions.filter(
    ({ evidenceId }) => evidenceId !== removedCard.unitId,
  );
  const partialGroupedReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    partialGroupedComparison,
    now,
  );
  assert.equal(partialGroupedReport.results[groupedComparisonIndex].passed, true);
  const incompleteComparison = structuredClone(runRecords);
  const comparisonIndex = dataset.cases.findIndex(({ category }) => category === 'COMPARISON');
  incompleteComparison[comparisonIndex].answer.exactResults.pop();
  incompleteComparison[comparisonIndex].evidence.pop();
  incompleteComparison[comparisonIndex].audit.candidateSet.pop();
  incompleteComparison[comparisonIndex].audit.rankingDecisions.pop();
  const incompleteComparisonReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    incompleteComparison,
    now,
  );
  assert.equal(
    incompleteComparisonReport.results[comparisonIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  const expandedGeo = structuredClone(runRecords);
  const expandedGeoRun = expandedGeo[geoIndex];
  const originalGeoResult = expandedGeoRun.answer.exactResults[0];
  const originalGeoEvidence = expandedGeoRun.evidence[0];
  const extraGeoResults = [2, 3, 4].map((ordinal) => {
    const unitId = `${ordinal}2000000-0000-4000-8000-${originalGeoResult.unitId.slice(-12)}`;
    return {
      ...originalGeoResult,
      unitId,
      href: `/objects/eval-project/lots/${unitId}`,
    };
  });
  const extraGeoEvidence = extraGeoResults.map((result) => ({
    ...originalGeoEvidence,
    unitId: result.unitId,
    unitExternalId: `eval-extra-${result.unitId.slice(-12)}`,
    lotTitle: result.title,
  }));
  expandedGeoRun.answer.totalExactResults = 4;
  expandedGeoRun.answer.exactResults.push(...extraGeoResults.slice(0, 2));
  expandedGeoRun.answer.additionalExactResults = extraGeoResults.slice(2);
  expandedGeoRun.answer.geo.markers.push(...extraGeoResults.slice(0, 2).map((result) => ({
    ...expandedGeoRun.answer.geo.markers[0],
    unitId: result.unitId,
  })));
  expandedGeoRun.evidence.push(...extraGeoEvidence);
  expandedGeoRun.audit.candidateSet.push(...extraGeoEvidence.map((evidence) => ({
    evidenceId: evidence.unitId,
    ...evidence,
  })));
  expandedGeoRun.audit.rankingDecisions.push(...extraGeoEvidence.map((evidence) => ({
    evidenceId: evidence.unitId,
    outcome: 'PRIMARY',
  })));
  expandedGeoRun.audit.evidenceRevisions.push(...extraGeoEvidence.map((evidence) => ({
    evidenceId: evidence.unitId,
  })));
  const expandedGeoReport = evaluateAssistantEvalArtifact(dataset, artifact, expandedGeo, now);
  assert.equal(
    expandedGeoReport.results[geoIndex].violations.includes('HARD_FILTER_VIOLATION'),
    false,
  );
  const additionalOutsideRadius = structuredClone(expandedGeo);
  additionalOutsideRadius[geoIndex].evidence.at(-1).latitude += 0.1;
  const additionalOutsideRadiusReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    additionalOutsideRadius,
    now,
  );
  assert.equal(
    additionalOutsideRadiusReport.results[geoIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  const substringComparison = structuredClone(runRecords);
  const riverComparisonIndex = dataset.cases.findIndex((item) => (
    item.category === 'COMPARISON'
      && item.expected.expectedIntent.comparisonTargets.includes('Река')
  ));
  const riverEvidenceIndex = substringComparison[riverComparisonIndex].evidence.findIndex(
    ({ objectTitle }) => objectTitle === 'Река',
  );
  substringComparison[riverComparisonIndex].evidence[riverEvidenceIndex].objectTitle = 'Зарека';
  const substringComparisonReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    substringComparison,
    now,
  );
  assert.equal(
    substringComparisonReport.results[riverComparisonIndex].violations.includes(
      'HARD_FILTER_VIOLATION',
    ),
    true,
  );
  const inventedNoDataResult = structuredClone(runRecords);
  const noDataIndex = dataset.cases.findIndex(({ category }) => category === 'NO_DATA');
  inventedNoDataResult[noDataIndex].answer = structuredClone(runRecords[searchIndex].answer);
  inventedNoDataResult[noDataIndex].evidence = structuredClone(runRecords[searchIndex].evidence);
  const inventedNoDataReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    inventedNoDataResult,
    now,
  );
  assert.equal(inventedNoDataReport.results[noDataIndex].passed, false);
  const legalBoundaryForNoData = structuredClone(runRecords);
  legalBoundaryForNoData[noDataIndex].answer = {
    kind: 'SAFE_BOUNDARY',
    content: [
      'Я могу помочь найти и сравнить объекты по подтверждённым данным Platforma,',
      'но ответ по налогам или правовым условиям не заменяет консультацию профильного специалиста.',
    ].join(' '),
  };
  const legalBoundaryForNoDataReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    legalBoundaryForNoData,
    now,
  );
  assert.equal(legalBoundaryForNoDataReport.results[noDataIndex].passed, false);
  const wrongClarificationContract = structuredClone(runRecords);
  wrongClarificationContract[clarificationIndex].answer.content = 'Safe boundary';
  wrongClarificationContract[clarificationIndex].intent.needsClarification = false;
  wrongClarificationContract[clarificationIndex].intent.clarificationQuestion = null;
  const wrongClarificationContractReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    wrongClarificationContract,
    now,
  );
  assert.equal(wrongClarificationContractReport.results[clarificationIndex].passed, false);
  const missingAlternative = structuredClone(runRecords);
  const alternativesIndex = dataset.cases.findIndex((item) => item.expected.explicitDeviationRequired);
  missingAlternative[alternativesIndex].answer.alternatives = [];
  missingAlternative[alternativesIndex].evidence = [];
  missingAlternative[alternativesIndex].audit.candidateSet = [];
  missingAlternative[alternativesIndex].audit.rankingDecisions = [];
  const missingAlternativeReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    missingAlternative,
    now,
  );
  assert.equal(missingAlternativeReport.results[alternativesIndex].passed, false);
  const mismatchedSourceAudit = structuredClone(runRecords);
  const sourceConflictIndex = dataset.cases.findIndex((item) => (
    item.expected.deterministicSourcePriorityRequired
  ));
  const semanticSourceConflict = structuredClone(runRecords);
  const semanticConflictRun = semanticSourceConflict[sourceConflictIndex];
  const [selectedConflictCandidate, rejectedConflictCandidate] = semanticConflictRun.audit.candidateSet;
  selectedConflictCandidate.label = 'Семейная ипотека застройщика';
  selectedConflictCandidate.value = 'Условия акции: ставка семейной ипотеки 4,4%.';
  selectedConflictCandidate.projectKey = 'konflikt-1';
  selectedConflictCandidate.developerKey = 'developer-example';
  rejectedConflictCandidate.label = 'Семейная ипотека банка';
  rejectedConflictCandidate.value = 'Условия акции: ставка семейной ипотеки 5,5%.';
  rejectedConflictCandidate.projectKey = null;
  rejectedConflictCandidate.developerKey = null;
  semanticConflictRun.evidence[0].label = selectedConflictCandidate.label;
  semanticConflictRun.evidence[0].value = selectedConflictCandidate.value;
  semanticConflictRun.evidence[0].projectKey = selectedConflictCandidate.projectKey;
  semanticConflictRun.evidence[0].developerKey = selectedConflictCandidate.developerKey;
  semanticConflictRun.answer.facts[0].label = selectedConflictCandidate.label;
  semanticConflictRun.answer.facts[0].value = selectedConflictCandidate.value;
  const semanticSourceConflictReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    semanticSourceConflict,
    now,
  );
  assert.equal(semanticSourceConflictReport.results[sourceConflictIndex].passed, true);
  const missingActualConflict = structuredClone(runRecords);
  missingActualConflict[sourceConflictIndex].audit.candidateSet.pop();
  missingActualConflict[sourceConflictIndex].audit.rankingDecisions.pop();
  const missingActualConflictReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    missingActualConflict,
    now,
  );
  assert.equal(
    missingActualConflictReport.results[sourceConflictIndex].violations.includes(
      'SOURCE_PRIORITY_VIOLATION',
    ),
    true,
  );
  const identicalConflictValues = structuredClone(runRecords);
  identicalConflictValues[sourceConflictIndex].audit.candidateSet[1].value =
    identicalConflictValues[sourceConflictIndex].audit.candidateSet[0].value;
  const identicalConflictValuesReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    identicalConflictValues,
    now,
  );
  assert.equal(
    identicalConflictValuesReport.results[sourceConflictIndex].violations.includes(
      'SOURCE_PRIORITY_VIOLATION',
    ),
    true,
  );
  const targetStaleIndex = dataset.cases.findIndex(({ category }) => category === 'STALE_PRICE');
  const wrongStaleUnit = structuredClone(runRecords);
  wrongStaleUnit[targetStaleIndex].evidence[0].unitExternalId = '9999';
  const wrongStaleUnitReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    wrongStaleUnit,
    now,
  );
  assert.equal(
    wrongStaleUnitReport.results[targetStaleIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  const externalIndex = dataset.cases.findIndex(({ category }) => category === 'EXTERNAL_LOT');
  const wrongExternalProject = structuredClone(runRecords);
  wrongExternalProject[externalIndex].evidence[0].projectKey = 'other-project';
  const wrongExternalProjectReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    wrongExternalProject,
    now,
  );
  assert.equal(
    wrongExternalProjectReport.results[externalIndex].violations.includes('HARD_FILTER_VIOLATION'),
    true,
  );
  mismatchedSourceAudit[sourceConflictIndex].evidence[0].sourcePriority = 1;
  const sourceMismatchReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    mismatchedSourceAudit,
    now,
  );
  assert.equal(
    sourceMismatchReport.results[sourceConflictIndex].violations.includes('SOURCE_PRIORITY_VIOLATION'),
    true,
  );
  const forgedInternalLotLink = structuredClone(runRecords);
  forgedInternalLotLink[searchIndex].answer.exactResults[0].href =
    `/objects/other-project/lots/${forgedInternalLotLink[searchIndex].answer.exactResults[0].unitId}`;
  const forgedInternalLotReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    forgedInternalLotLink,
    now,
  );
  assert.equal(
    forgedInternalLotReport.results[searchIndex].violations.includes('UNSUPPORTED_LINK'),
    true,
  );
  const forgedInternalPdfLink = structuredClone(runRecords);
  forgedInternalPdfLink[searchIndex].answer.exactResults[0].pdfs = [{
    title: 'Неподтверждённый PDF',
    href: '/media/files/80000000-0000-4000-8000-000000000001/content?download=true',
  }];
  const forgedInternalPdfReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    forgedInternalPdfLink,
    now,
  );
  assert.equal(
    forgedInternalPdfReport.results[searchIndex].violations.includes('UNSUPPORTED_LINK'),
    true,
  );
  const crossCardLink = structuredClone(runRecords);
  const secondUnitId = '90000000-0000-4000-8000-000000000001';
  const secondCard = {
    ...crossCardLink[searchIndex].answer.exactResults[0],
    unitId: secondUnitId,
    href: `/objects/second-project/lots/${secondUnitId}`,
  };
  crossCardLink[searchIndex].answer.exactResults.push(secondCard);
  crossCardLink[searchIndex].evidence.push({
    ...crossCardLink[searchIndex].evidence[0],
    unitId: secondUnitId,
    objectSlug: 'second-project',
  });
  crossCardLink[searchIndex].answer.exactResults[0].href = secondCard.href;
  const crossCardLinkReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    crossCardLink,
    now,
  );
  assert.equal(
    crossCardLinkReport.results[searchIndex].violations.includes('UNSUPPORTED_LINK'),
    true,
  );
  const malformedSourceMetadata = structuredClone(runRecords);
  const factualIndex = dataset.cases.findIndex(({ category }) => category === 'FACTUAL');
  delete malformedSourceMetadata[factualIndex].evidence[0].sourceType;
  const malformedSourceReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    malformedSourceMetadata,
    now,
  );
  assert.equal(
    malformedSourceReport.results[factualIndex].violations.includes('SOURCE_PRIORITY_VIOLATION'),
    true,
  );
  const forgedStaleLabel = structuredClone(runRecords);
  const staleIndex = dataset.cases.findIndex(({ category }) => category === 'STALE_PRICE');
  forgedStaleLabel[staleIndex].evidence[0].updatedAt = now.toISOString();
  const forgedStaleReport = evaluateAssistantEvalArtifact(
    dataset,
    artifact,
    forgedStaleLabel,
    now,
  );
  assert.equal(forgedStaleReport.results[staleIndex].passed, false);

  for (const violation of assistantEvalZeroToleranceViolations) {
    const failedRecords = structuredClone(runRecords);
    breakEvalInvariant(failedRecords, dataset.cases, violation);
    const failed = scoreAssistantEval(
      dataset,
      evaluateAssistantEvalArtifact(dataset, artifact, failedRecords, now),
    );
    assert.equal(failed.passed, false);
    assert.equal(
      failed.gates.some((gate) => gate.code === `ZERO_TOLERANCE_${violation}` && !gate.passed),
      true,
    );
  }
});

test('Assistant T07 eval fails closed on version drift, missing cases and frozen threshold breaches', () => {
  const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(datasetPath, 'utf8')));
  const results = dataset.cases.map(({ id }, index) => ({
    id,
    passed: index >= 21,
    qualityScore: index >= 21 ? 1 : 0,
    latencyMs: index < 21 ? 16_000 : 1_000,
    modelAttempts: index === 199 ? 23 : 1,
    totalTokens: index === 199 ? 500_000 : 500,
    geoProviderCalls: index < 60 ? 1 : 0,
    violations: [],
  }));
  const failed = scoreAssistantEval(dataset, {
    datasetVersion: dataset.version,
    results,
  });

  assert.equal(failed.passed, false);
  assert.equal(failed.gates.some((gate) => gate.code === 'OVERALL_PASS_RATE' && !gate.passed), true);
  assert.equal(failed.gates.some((gate) => gate.code === 'P95_LATENCY' && !gate.passed), true);
  assert.equal(failed.gates.some((gate) => gate.code === 'AVERAGE_MODEL_ATTEMPTS' && !gate.passed), true);
  assert.equal(failed.gates.some((gate) => gate.code === 'AVERAGE_TOTAL_TOKENS' && !gate.passed), true);
  assert.equal(failed.gates.some((gate) => gate.code === 'AVERAGE_GEO_PROVIDER_CALLS' && !gate.passed), true);

  assert.throws(
    () => scoreAssistantEval(dataset, { datasetVersion: 'assistant-eval-v2', results }),
    /ASSISTANT_EVAL_DATASET_VERSION_MISMATCH/u,
  );
  assert.throws(
    () => scoreAssistantEval(dataset, {
      datasetVersion: dataset.version,
      results: results.slice(1),
    }),
    /ASSISTANT_EVAL_RESULTS_INCOMPLETE/u,
  );
});

test('Assistant T07 rollout config keeps assistant, geo and connector flags independent and validates the pilot allowlist', () => {
  const admin = actor('11111111-1111-4111-8111-111111111111', [
    'objects:read',
    'assistant:audit:read',
  ]);
  const pilot = actor('22222222-2222-4222-8222-222222222222', ['objects:read']);
  const reader = actor('33333333-3333-4333-8333-333333333333', ['objects:read']);
  const platformAdmin = actor('44444444-4444-4444-8444-444444444444', [
    'objects:read',
    'admin:access',
  ]);
  const baseEnvironment = {
    ASSISTANT_MODULE_ENABLED: 'true',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'false',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false',
    ASSISTANT_ROLLOUT_STAGE: 'ADMINS',
    ASSISTANT_PILOT_USER_IDS: pilot.id,
  };

  const admins = getAssistantRuntimeConfig(baseEnvironment);
  assert.equal(admins.assistantEnabled, true);
  assert.equal(admins.geoProviderEnabled, false);
  assert.equal(admins.externalConnectorsEnabled, false);
  assert.equal(admins.rolloutStage, 'ADMINS');
  assert.equal(isAssistantEnabledForActor(admin, baseEnvironment), true);
  assert.equal(isAssistantEnabledForActor(platformAdmin, baseEnvironment), true);
  assert.equal(isAssistantEnabledForActor(pilot, baseEnvironment), false);

  const pilotEnvironment = { ...baseEnvironment, ASSISTANT_ROLLOUT_STAGE: 'PILOT' };
  assert.equal(isAssistantEnabledForActor(admin, pilotEnvironment), true);
  assert.equal(isAssistantEnabledForActor(pilot, pilotEnvironment), true);
  assert.equal(isAssistantEnabledForActor(reader, pilotEnvironment), false);

  const allEnvironment = { ...baseEnvironment, ASSISTANT_ROLLOUT_STAGE: 'ALL' };
  assert.equal(isAssistantEnabledForActor(reader, allEnvironment), true);

  const independentEnvironment = {
    ...baseEnvironment,
    ASSISTANT_MODULE_ENABLED: 'false',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'true',
  };
  assert.deepEqual(getAssistantRuntimeConfig(independentEnvironment), {
    assistantEnabled: false,
    geoProviderEnabled: true,
    externalConnectorsEnabled: true,
    rolloutStage: 'ADMINS',
    pilotUserIds: [pilot.id],
  });

  assert.throws(
    () => getAssistantRuntimeConfig({
      ...baseEnvironment,
      ASSISTANT_PILOT_USER_IDS: 'not-a-uuid',
    }),
    /ASSISTANT_PILOT_USER_IDS_INVALID/u,
  );
});

test('Assistant T07 rollout transition is sequential and blocked by eval, source health, budgets and critical errors', () => {
  const ready = {
    currentStage: 'ADMINS',
    targetStage: 'PILOT',
    evalPassed: true,
    sourceHealthPassed: true,
    budgetsConfigured: true,
    criticalErrorCount: 0,
    providerBudgetContractPassed: true,
    pilotCohortPassed: true,
    observationPassed: true,
  };

  assert.deepEqual(assessAssistantRolloutTransition(ready), {
    passed: true,
    blockers: [],
  });
  assert.deepEqual(assessAssistantRolloutTransition({
    ...ready,
    providerBudgetContractPassed: undefined,
  }), {
    passed: false,
    blockers: ['PROVIDER_BUDGET_CONTRACT_VIOLATION'],
  });
  assert.deepEqual(assessAssistantRolloutTransition({
    ...ready,
    targetStage: 'ALL',
    evalPassed: false,
    sourceHealthPassed: false,
    budgetsConfigured: false,
    criticalErrorCount: 2,
    pilotCohortPassed: false,
    observationPassed: false,
  }), {
    passed: false,
    blockers: [
      'ASSISTANT_ROLLOUT_STAGE_NOT_SEQUENTIAL',
      'ASSISTANT_ROLLOUT_EVAL_FAILED',
      'ASSISTANT_ROLLOUT_SOURCE_HEALTH_FAILED',
      'ASSISTANT_ROLLOUT_BUDGETS_NOT_CONFIGURED',
      'ASSISTANT_ROLLOUT_CRITICAL_ERRORS_PRESENT',
      'ASSISTANT_ROLLOUT_PILOT_COHORT_INVALID',
      'ASSISTANT_ROLLOUT_OBSERVATION_INSUFFICIENT',
    ],
  });
});

test('ZAEBAL4 rollout reconciles stage-created, observation-completed and stage-attempt runs', () => {
  assert.deepEqual(collectAssistantProviderComparisonRunIds(
    [{ id: 'created-during-stage' }],
    [{ id: 'created-before-stage-completed-during-stage' }],
    [
      { operation: 'PLANNER', operationRunId: 'settled-during-stage' },
      { operation: 'SOURCE_DISCOVERY', operationRunId: 'admin-source-run' },
      { operation: 'PLANNER', operationRunId: 'created-during-stage' },
    ],
  ), [
    'created-during-stage',
    'created-before-stage-completed-during-stage',
    'settled-during-stage',
  ]);
});

test('Assistant T07 disabled Geo Provider degrades without a provider call or budget reservation', async () => {
  let providerCalls = 0;
  let budgetReservations = 0;
  const policy = new AssistantGeoProviderPolicyService(
    {},
    {
      async search() {
        providerCalls += 1;
        return [];
      },
    },
    {
      ASSISTANT_GEO_PROVIDER_ENABLED: 'false',
      ASSISTANT_GEO_PROVIDER_MODE: 'locationiq',
    },
    () => new Date('2026-08-26T12:00:00.000Z'),
    async () => {},
    {
      async reserve() {
        budgetReservations += 1;
      },
      async complete() {},
    },
  );

  await assert.rejects(
    policy.searchWithTelemetry({
      purpose: 'METADATA', expectedKind: 'POINT',
      query: 'Павелецкая Плаза', locale: 'ru', country: 'ru', viewbox: null,
    }),
    (error) => error instanceof AssistantGeoProviderError
      && error.code === 'ASSISTANT_GEO_PROVIDER_DISABLED'
      && error.providerCallCount === 0,
  );
  assert.equal(providerCalls, 0);
  assert.equal(budgetReservations, 0);
});

test('Assistant T07 connector refresh and source worker require the independent external-connectors flag', () => {
  const refreshGuards = Reflect.getMetadata(
    GUARDS_METADATA,
    AssistantSourcesController.prototype.refresh,
  ) ?? [];
  const projectRefreshGuards = Reflect.getMetadata(
    GUARDS_METADATA,
    AssistantSourcesController.prototype.refreshProject,
  ) ?? [];

  assert.equal(refreshGuards.includes(AssistantExternalConnectorsGuard), true);
  assert.equal(projectRefreshGuards.includes(AssistantExternalConnectorsGuard), true);
  assert.equal(isAssistantSourceWorkerRunnable({
    ASSISTANT_SOURCE_WORKER_ENABLED: 'true',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false',
  }), false);
  assert.equal(isAssistantSourceWorkerRunnable({
    ASSISTANT_SOURCE_WORKER_ENABLED: 'true',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'true',
  }), true);
});

test('Assistant T07 rollout preflight fails closed on stale sources, implicit budgets and critical prior-stage runs', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');
  assert.deepEqual(assessAssistantSourceHealth([
    {
      id: 'source-ok',
      lastSuccessAt: new Date('2026-08-26T10:00:00.000Z'),
      lastIndexedAt: new Date('2026-08-26T10:00:00.000Z'),
      lastErrorCode: null,
    },
    {
      id: 'source-stale',
      lastSuccessAt: new Date('2026-08-24T20:00:00.000Z'),
      lastIndexedAt: new Date('2026-08-24T20:00:00.000Z'),
      lastErrorCode: 'SOURCE_TIMEOUT',
    },
  ], now), {
    passed: false,
    activeSourceCount: 2,
    unhealthySourceIds: ['source-stale'],
  });
  assert.deepEqual(assessAssistantSourceHealth([], now), {
    passed: false,
    activeSourceCount: 0,
    unhealthySourceIds: [],
  });
  assert.deepEqual(assessAssistantSourceHealth([{
    id: 'source-unchanged-but-reverified',
    lastSuccessAt: new Date('2026-08-26T11:55:00.000Z'),
    lastIndexedAt: new Date('2026-08-20T10:00:00.000Z'),
    lastErrorCode: null,
  }], now), {
    passed: true,
    activeSourceCount: 1,
    unhealthySourceIds: [],
  });

  assert.deepEqual(readAssistantRolloutBudgetReadiness({
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    ASSISTANT_MODEL_REQUESTS_PER_MINUTE: '60',
    ASSISTANT_MODEL_REQUESTS_PER_DAY: '5000',
    ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '60',
    ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '1000',
    ASSISTANT_GEO_CACHE_TTL_SECONDS: '3600',
  }), {
    passed: true,
    missing: [],
  });
  assert.deepEqual(readAssistantRolloutBudgetReadiness({
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
  }), {
    passed: false,
    missing: [
      'ASSISTANT_MODEL_REQUESTS_PER_MINUTE',
      'ASSISTANT_MODEL_REQUESTS_PER_DAY',
      'ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE',
      'ASSISTANT_GEO_PROVIDER_DAILY_BUDGET',
      'ASSISTANT_GEO_CACHE_TTL_SECONDS',
    ],
  });
  for (const invalidTtl of ['59', '31536001', 'not-a-number']) {
    assert.deepEqual(readAssistantRolloutBudgetReadiness({
      ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
      ASSISTANT_MODEL_REQUESTS_PER_MINUTE: '60',
      ASSISTANT_MODEL_REQUESTS_PER_DAY: '5000',
      ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE: '60',
      ASSISTANT_GEO_PROVIDER_DAILY_BUDGET: '1000',
      ASSISTANT_GEO_CACHE_TTL_SECONDS: invalidTtl,
    }), {
      passed: false,
      missing: ['ASSISTANT_GEO_CACHE_TTL_SECONDS'],
    });
  }

  assert.equal(countAssistantRolloutCriticalErrors([
    { status: 'COMPLETED', qualityFlags: [] },
    { status: 'FAILED', qualityFlags: [] },
    { status: 'COMPLETED', qualityFlags: ['MODEL_FALLBACK'] },
    { status: 'COMPLETED', qualityFlags: ['HARD_FILTER_VIOLATION'] },
    { status: 'COMPLETED', qualityFlags: ['BROKEN_LINK', 'LATENCY_BREACH'] },
  ]), 3);

  const pilotUserIds = Array.from({ length: 10 }, (_, index) => (
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  ));
  const pilotUsers = pilotUserIds.map((id) => ({
    id,
    status: 'ACTIVE',
    deletedAt: null,
    permissions: ['objects:read'],
  }));
  assert.deepEqual(assessAssistantPilotCohort(pilotUserIds, pilotUsers), {
    passed: true,
    configuredCount: 10,
    userIds: pilotUserIds,
    missingUserIds: [],
    ineligibleUserIds: [],
  });
  assert.equal(assessAssistantPilotCohort([], []).passed, false);
  assert.equal(assessAssistantPilotCohort(pilotUserIds, [
    ...pilotUsers.slice(0, 9),
    { ...pilotUsers[9], permissions: ['objects:read', 'admin:access'] },
  ]).passed, false);

  const observedRuns = pilotUserIds.map((ownerUserId) => ({
    ownerUserId,
    status: 'COMPLETED',
    qualityFlags: [],
    completedAt: new Date('2026-08-26T11:00:00.000Z'),
  }));
  assert.equal(assessAssistantRolloutObservation({
    currentStage: 'PILOT',
    pilotUserIds,
    previousStageStartedAt: new Date('2026-08-26T10:00:00.000Z'),
    now,
    runs: observedRuns,
  }).passed, true);
  assert.equal(assessAssistantRolloutObservation({
    currentStage: 'PILOT',
    pilotUserIds,
    previousStageStartedAt: new Date('2026-08-26T13:00:00.000Z'),
    now,
    runs: [],
  }).passed, false);
  assert.equal(assessAssistantRolloutObservation({
    currentStage: 'PILOT',
    pilotUserIds,
    previousStageStartedAt: new Date('2026-08-26T10:00:00.000Z'),
    now,
    runs: observedRuns.slice(1),
  }).passed, false);
  assert.equal(assessAssistantRolloutObservation({
    currentStage: 'PILOT',
    pilotUserIds,
    previousStageStartedAt: new Date('2026-08-26T10:00:00.000Z'),
    now,
    runs: pilotUserIds.map((ownerUserId, index) => ({
      ownerUserId,
      status: index === 0 ? 'RUNNING' : 'COMPLETED',
      qualityFlags: [],
      completedAt: index === 0 ? null : new Date('2026-08-26T13:00:00.000Z'),
    })),
  }).passed, false);

  const adminsEvent = {
    stage: 'ADMINS',
    gateDigest: '0'.repeat(64),
    approvalJson: { kind: 'MIGRATION_BASELINE', passed: true, targetStage: 'ADMINS' },
    startedAt: new Date('2026-08-26T09:00:00.000Z'),
  };
  const pilotStartedAt = new Date('2026-08-26T10:00:00.000Z');
  const pilotApproval = rolloutApproval('PILOT', pilotStartedAt);
  const pilotEvent = {
    stage: 'PILOT',
    gateDigest: computeAssistantRolloutApprovalDigest(pilotApproval),
    approvalJson: pilotApproval,
    startedAt: pilotStartedAt,
  };
  assert.equal(assessAssistantPilotCohortAgainstApproval(
    pilotUserIds,
    pilotUsers,
    pilotApproval,
  ).passed, true);
  assert.equal(assessAssistantPilotCohortAgainstApproval(
    [...pilotUserIds.slice(0, 9), '00000000-0000-4000-8000-000000000099'],
    [
      ...pilotUsers.slice(0, 9),
      {
        id: '00000000-0000-4000-8000-000000000099',
        status: 'ACTIVE',
        deletedAt: null,
        permissions: ['objects:read'],
      },
    ],
    pilotApproval,
  ).passed, false);
  assert.deepEqual(assessAssistantRolloutStageRecord('PILOT', [adminsEvent], now), {
    passed: true,
    current: null,
    previous: adminsEvent,
    blocker: null,
  });
  assert.equal(assessAssistantRolloutStageRecord('ALL', [adminsEvent, pilotEvent], now).passed, true);
  assert.equal(assessAssistantRolloutStageRecord('ALL', [adminsEvent, {
    ...pilotEvent,
    approvalJson: { ...pilotEvent.approvalJson, passed: false },
  }], now).blocker, 'ASSISTANT_ROLLOUT_STAGE_APPROVAL_INVALID');
  assert.equal(assessAssistantRolloutStageRecord('ALL', [], now).passed, false);
  assert.equal(assessAssistantRolloutStageRecord('ALL', [
    { ...pilotEvent, stage: 'ALL', approvalJson: { ...pilotEvent.approvalJson, targetStage: 'ALL' } },
  ], now).passed, false);
  assert.equal(assessAssistantRolloutStageRecord('PILOT', [
    { ...pilotEvent, startedAt: new Date('2026-08-26T13:00:00.000Z') },
  ], now).passed, false);
});

test('ZAEBAL4 rollout treats provider overcharge, RESERVED receipts and reported usage mismatch as critical', () => {
  const cleanAttempt = {
    operationRunId: 'zaebal4-rollout-clean',
    executionId: '11111111-1111-4111-8111-111111111111',
    attemptOrdinal: 1,
    operation: 'SOURCE_DISCOVERY',
    status: 'SETTLED',
    outcome: 'PROVIDER_SUCCESS',
    pricingStatus: 'PRICED',
    reservedCostUsd: '0.03000000',
    chargedCostUsd: '0.02000000',
    webSearchCalls: 1,
  };
  assert.deepEqual(assessAssistantProviderBudgetContract([cleanAttempt]), {
    passed: true,
    condition: null,
    violationCount: 0,
    violatingReceipts: [],
    reportedUsageMismatches: [],
  });
  assert.equal(assessAssistantProviderBudgetContract([{
    ...cleanAttempt,
    operationRunId: 'zaebal4-rollout-actual-model-alias',
    operation: 'PLANNER',
    requestedModel: 'gpt-5.6-luna',
    actualModel: 'gpt-5.6-luna-2026-08-01',
    inputTokens: 20n,
    cachedInputTokens: 4n,
    cacheWriteInputTokens: 2n,
    outputTokens: 10n,
    reasoningTokens: 3n,
    totalTokens: 30n,
    webSearchCalls: 0,
  }], {
    operationRunIds: ['zaebal4-rollout-actual-model-alias'],
    operations: ['PLANNER'],
    reportedUsage: [{
      operationRunId: 'zaebal4-rollout-actual-model-alias',
      model: 'gpt-5.6-luna-2026-08-01',
      inputTokens: 20,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 2,
      outputTokens: 10,
      reasoningTokens: 3,
      totalTokens: 30,
      webSearchCalls: 0,
    }],
  }).passed, true);

  const usageMismatchRunId = 'zaebal4-rollout-usage-mismatch';
  const assessment = assessAssistantProviderBudgetContract([
    {
      ...cleanAttempt,
      operationRunId: 'zaebal4-rollout-overcharge',
      chargedCostUsd: '0.04000000',
      pricingStatus: 'RESERVE_EXCEEDED',
    },
    {
      ...cleanAttempt,
      operationRunId: 'zaebal4-rollout-reserved',
      executionId: '22222222-2222-4222-8222-222222222222',
      status: 'RESERVED',
      outcome: null,
      pricingStatus: 'RESERVED',
      chargedCostUsd: null,
      webSearchCalls: null,
    },
    {
      ...cleanAttempt,
      operationRunId: 'zaebal4-rollout-tool-contract',
      executionId: '33333333-3333-4333-8333-333333333333',
      webSearchCalls: 2,
      outcome: 'PROVIDER_CONTRACT_VIOLATION',
    },
    {
      ...cleanAttempt,
      operationRunId: usageMismatchRunId,
      executionId: '44444444-4444-4444-8444-444444444443',
      operation: 'PLANNER',
      requestedModel: 'gpt-5.6-luna',
      status: 'SETTLED',
      outcome: 'UNKNOWN_AFTER_CRASH',
      pricingStatus: 'USAGE_INCOMPLETE',
      chargedCostUsd: '0.03000000',
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      webSearchCalls: null,
    },
    {
      ...cleanAttempt,
      operationRunId: usageMismatchRunId,
      executionId: '44444444-4444-4444-8444-444444444444',
      attemptOrdinal: 2,
      operation: 'EMBEDDING_RETRIEVAL',
      requestedModel: 'text-embedding-3-small',
      inputTokens: 8n,
      cachedInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      totalTokens: 8n,
      webSearchCalls: 0,
      outcome: 'ACCEPTED',
    },
    {
      ...cleanAttempt,
      operationRunId: usageMismatchRunId,
      executionId: '44444444-4444-4444-8444-444444444444',
      operation: 'PLANNER',
      requestedModel: 'gpt-5.6-luna',
      inputTokens: 20n,
      cachedInputTokens: 4n,
      cacheWriteInputTokens: 2n,
      outputTokens: 10n,
      reasoningTokens: 3n,
      totalTokens: 30n,
      webSearchCalls: 0,
      outcome: 'ACCEPTED',
    },
  ], {
    operationRunIds: [usageMismatchRunId],
    operations: ['PLANNER'],
    executions: [{
      operationRunId: usageMismatchRunId,
      executionId: '44444444-4444-4444-8444-444444444444',
    }],
    reportedUsage: [{
      operationRunId: usageMismatchRunId,
      model: 'gpt-5.6-luna',
      inputTokens: 21,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 2,
      outputTokens: 10,
      reasoningTokens: 3,
      totalTokens: 30,
      webSearchCalls: 0,
    }],
  });

  assert.deepEqual(assessment, {
    passed: false,
    condition: 'PROVIDER_BUDGET_CONTRACT_VIOLATION',
    violationCount: 4,
    violatingReceipts: [
      {
        operationRunId: 'zaebal4-rollout-overcharge',
        executionId: '11111111-1111-4111-8111-111111111111',
        attemptOrdinal: 1,
        reasons: ['CHARGE_EXCEEDS_RESERVE'],
      },
      {
        operationRunId: 'zaebal4-rollout-reserved',
        executionId: '22222222-2222-4222-8222-222222222222',
        attemptOrdinal: 1,
        reasons: ['ATTEMPT_RESERVED'],
      },
      {
        operationRunId: 'zaebal4-rollout-tool-contract',
        executionId: '33333333-3333-4333-8333-333333333333',
        attemptOrdinal: 1,
        reasons: ['TOOL_CALL_CONTRACT_VIOLATION'],
      },
    ],
    reportedUsageMismatches: [{
      operationRunId: usageMismatchRunId,
      receiptAttemptCount: 1,
      reportedAttemptCount: 1,
      fields: ['inputTokens'],
    }],
  });

  const aggregateCollisionRunId = 'zaebal4-rollout-aggregate-collision';
  const aggregateCollision = assessAssistantProviderBudgetContract([
    {
      ...cleanAttempt,
      operationRunId: aggregateCollisionRunId,
      executionId: '55555555-5555-4555-8555-555555555555',
      attemptOrdinal: 1,
      operation: 'PLANNER',
      requestedModel: 'gpt-5.6-luna',
      inputTokens: 10n,
      cachedInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 5n,
      reasoningTokens: 2n,
      totalTokens: 15n,
      webSearchCalls: 0,
    },
    {
      ...cleanAttempt,
      operationRunId: aggregateCollisionRunId,
      executionId: '55555555-5555-4555-8555-555555555555',
      attemptOrdinal: 2,
      operation: 'PLANNER',
      requestedModel: 'gpt-5.6-luna',
      inputTokens: 20n,
      cachedInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 5n,
      reasoningTokens: 2n,
      totalTokens: 25n,
      webSearchCalls: 0,
    },
  ], {
    operationRunIds: [aggregateCollisionRunId],
    operations: ['PLANNER'],
    executions: [{
      operationRunId: aggregateCollisionRunId,
      executionId: '55555555-5555-4555-8555-555555555555',
    }],
    reportedUsage: [
      {
        operationRunId: aggregateCollisionRunId,
        model: 'gpt-5.6-luna',
        inputTokens: 11,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 15,
        webSearchCalls: 0,
      },
      {
        operationRunId: aggregateCollisionRunId,
        model: 'gpt-5.6-luna',
        inputTokens: 19,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 25,
        webSearchCalls: 0,
      },
    ],
  });
  assert.deepEqual(aggregateCollision.reportedUsageMismatches, [{
    operationRunId: aggregateCollisionRunId,
    receiptAttemptCount: 2,
    reportedAttemptCount: 2,
    fields: ['inputTokens'],
  }]);

  const ordinalMismatch = assessAssistantProviderBudgetContract([
    {
      ...cleanAttempt,
      operationRunId: aggregateCollisionRunId,
      executionId: '55555555-5555-4555-8555-555555555555',
      attemptOrdinal: 1,
      operation: 'PLANNER',
      requestedModel: 'gpt-5.6-luna',
      inputTokens: 10n,
      cachedInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 5n,
      reasoningTokens: 2n,
      totalTokens: 15n,
      webSearchCalls: 0,
    },
    {
      ...cleanAttempt,
      operationRunId: aggregateCollisionRunId,
      executionId: '55555555-5555-4555-8555-555555555555',
      attemptOrdinal: 2,
      operation: 'PLANNER',
      requestedModel: 'gpt-5.6-luna',
      inputTokens: 20n,
      cachedInputTokens: 0n,
      cacheWriteInputTokens: 0n,
      outputTokens: 5n,
      reasoningTokens: 2n,
      totalTokens: 25n,
      webSearchCalls: 0,
    },
  ], {
    operationRunIds: [aggregateCollisionRunId],
    operations: ['PLANNER'],
    executions: [{
      operationRunId: aggregateCollisionRunId,
      executionId: '55555555-5555-4555-8555-555555555555',
    }],
    reportedUsage: [
      {
        operationRunId: aggregateCollisionRunId,
        attemptOrdinal: 2,
        model: 'gpt-5.6-luna',
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 15,
        webSearchCalls: 0,
      },
      {
        operationRunId: aggregateCollisionRunId,
        attemptOrdinal: 3,
        model: 'gpt-5.6-luna',
        inputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 25,
        webSearchCalls: 0,
      },
    ],
  });
  assert.deepEqual(ordinalMismatch.reportedUsageMismatches, [{
    operationRunId: aggregateCollisionRunId,
    receiptAttemptCount: 2,
    reportedAttemptCount: 2,
    fields: ['attemptOrdinal'],
  }]);

  assert.deepEqual(assessAssistantRolloutTransition({
    currentStage: 'ADMINS',
    targetStage: 'PILOT',
    evalPassed: true,
    sourceHealthPassed: true,
    budgetsConfigured: true,
    criticalErrorCount: assessment.violationCount,
    providerBudgetContractPassed: assessment.passed,
    pilotCohortPassed: true,
    observationPassed: true,
  }), {
    passed: false,
    blockers: [
      'ASSISTANT_ROLLOUT_CRITICAL_ERRORS_PRESENT',
      'PROVIDER_BUDGET_CONTRACT_VIOLATION',
    ],
  });
});

test('PIDAFIX1 paid readiness is shared, fail-closed and redacts the OpenAI key', () => {
  const blocked = readAssistantPaidProviderReadiness({ ASSISTANT_AI_MODE: 'openai' });
  assert.equal(blocked.passed, false);
  assert.deepEqual(blocked.missing, [
    'ASSISTANT_MODEL_REQUESTS_PER_MINUTE',
    'ASSISTANT_MODEL_REQUESTS_PER_DAY',
    'ASSISTANT_MODEL_DAILY_BUDGET_USD',
    'ASSISTANT_QUERY_PLANNER_LIVE',
    'ASSISTANT_PAID_CALLS_CONFIRMED',
    'OPENAI_API_KEY',
  ]);
  assert.equal(blocked.effective.apiKeyPresent, false);

  const ready = readAssistantPaidProviderReadiness({
    ASSISTANT_AI_MODE: 'openai',
    ASSISTANT_MODEL_REQUESTS_PER_MINUTE: '2',
    ASSISTANT_MODEL_REQUESTS_PER_DAY: '2',
    ASSISTANT_MODEL_DAILY_BUDGET_USD: '0.50',
    ASSISTANT_QUERY_PLANNER_LIVE: 'true',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'true',
    OPENAI_API_KEY: 'must-not-be-returned',
  });
  assert.deepEqual(ready, {
    passed: true,
    missing: [],
    effective: {
      aiMode: 'openai',
      requestsPerMinute: 2,
      requestsPerDay: 2,
      dailyBudgetUsd: '0.50000000',
      queryPlannerLive: true,
      paidCallsConfirmed: true,
      apiKeyPresent: true,
    },
  });
  assert.equal(JSON.stringify(ready).includes('must-not-be-returned'), false);
});

test('Assistant T07 rollout flags and explicit budgets are documented in env and Compose without frontend provider keys', () => {
  const rootEnv = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
  const apiEnv = readFileSync(resolve(__dirname, '../.env.example'), 'utf8');
  const compose = readFileSync(resolve(__dirname, '../../../docker-compose.yml'), 'utf8');
  const configuration = `${rootEnv}\n${apiEnv}\n${compose}`;

  for (const name of [
    'ASSISTANT_ROLLOUT_STAGE',
    'ASSISTANT_PILOT_USER_IDS',
    'ASSISTANT_GEO_PROVIDER_ENABLED',
    'ASSISTANT_EXTERNAL_CONNECTORS_ENABLED',
    'ASSISTANT_MODEL_REQUESTS_PER_MINUTE',
    'ASSISTANT_MODEL_REQUESTS_PER_DAY',
    'ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE',
  ]) {
    assert.match(configuration, new RegExp(`${name}=`));
  }
  assert.match(compose, /MAP_PROVIDER_ENABLED: \$\{MAP_PROVIDER_ENABLED:-true\}/u);
  assert.match(compose, /assistant-source-worker:[\s\S]*?profiles: \["assistant-external"\]/u);
  assert.doesNotMatch(configuration, /VITE_(?:LOCATIONIQ|OPENAI|ASSISTANT_GEO_PROVIDER|ASSISTANT_EXTERNAL_CONNECTORS)/u);
});

function actor(id, permissions) {
  return {
    id,
    permissions,
  };
}

function perfectEvalArtifact(dataset, now) {
  return {
    datasetVersion: dataset.version,
    datasetSha256: computeAssistantEvalDatasetSha256(dataset),
    evaluatorVersion: 'assistant-evaluator-v1',
    evaluatedAt: now.toISOString(),
    runs: dataset.cases.map((item, index) => ({
      caseId: item.id,
      runId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })),
  };
}

function perfectEvalRunRecords(dataset, now) {
  return dataset.cases.map((item, index) => perfectEvalRunRecord(
    item,
    `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    now,
  ));
}

function perfectEvalRunRecord(item, id, now) {
  const expected = item.expected;
  const answerKind = expected.answerKinds[0];
  const knowledgeFragments = expected.expectedKnowledge?.requiredTextFragments ?? [];
  const knowledgeLabel = item.category === 'EXTERNAL_LOT'
    ? knowledgeFragments[0]
    : item.category === 'MORTGAGE_INSTALLMENT'
      ? knowledgeFragments[0] === 'ипотеч' ? 'Ипотечная программа' : 'Рассрочка'
      : item.category === 'SOURCE_CONFLICT'
        ? 'Акция'
        : knowledgeFragments[0] ?? 'Подтверждённый факт';
  const knowledgeValue = item.category === 'MORTGAGE_INSTALLMENT'
    ? `${knowledgeLabel}. Первоначальный взнос ${knowledgeFragments[1]}.`
    : item.category === 'SOURCE_CONFLICT'
      ? 'Актуальные условия акции'
      : `Подтверждённое значение: ${knowledgeLabel}`;
  const resultId = `20000000-0000-4000-8000-${id.slice(-12)}`;
  const objectId = `60000000-0000-4000-8000-${id.slice(-12)}`;
  const geoPoint = expected.expectedGeo
    ? projectNorth(expected.expectedGeo.latitude, expected.expectedGeo.longitude, 900)
    : null;
  const isAlternative = Boolean(expected.explicitDeviationRequired);
  const result = {
    unitId: resultId,
    title: expected.expectedUnitExternalId
      ? `Лот ${expected.expectedUnitExternalId}`
      : 'Eval result',
    subtitle: 'Eval project',
    priceRub: 20_000_000,
    availabilityLabel: 'В продаже',
    freshnessLabel: expected.staleLabelRequired ? 'Данные могут быть устаревшими' : 'Обновлено сегодня',
    isStale: Boolean(expected.staleLabelRequired),
    href: `/objects/eval-project/lots/${resultId}`,
    facts: [],
    pdfs: [],
    deviations: isAlternative ? [{ type: 'BUDGET', label: 'Бюджет выше на 1 000 000 ₽' }] : [],
    ...(expected.distanceRequired ? { distanceMeters: 900 } : {}),
  };
  const searchAnswer = {
    kind: 'SEARCH_RESULTS',
    content: isAlternative
      ? 'Точных совпадений нет. Показываю ближайшие альтернативы с явными отклонениями.'
      : expected.expectedIntent?.taskType === 'COMPARE'
        ? 'Сравнил подтверждённые предложения по двум выбранным вариантам.'
        : 'Нашёл точные предложения по указанным критериям.',
    exactResults: isAlternative ? [] : [result],
    alternatives: isAlternative ? [result] : [],
    ...(expected.expectedGeo ? {
      geo: {
        anchor: {
          latitude: expected.expectedGeo.latitude,
          longitude: expected.expectedGeo.longitude,
          label: expected.expectedGeo.anchorLabel,
        },
        radiusMeters: expected.expectedGeo.radiusMeters,
        polygon: { type: 'Polygon', coordinates: [[[37.6, 55.7], [37.7, 55.7], [37.6, 55.7]]] },
        markers: [{
          unitId: resultId,
          latitude: geoPoint.latitude,
          longitude: geoPoint.longitude,
          distanceMeters: 900,
          kind: isAlternative ? 'ALTERNATIVE' : 'PRIMARY',
        }],
      },
    } : {}),
  };
  const knowledgeId = `30000000-0000-4000-8000-${id.slice(-12)}`;
  const external = Boolean(expected.externalHttpsLinkRequired);
  const knowledgeAnswer = {
    kind: 'KNOWLEDGE_RESULTS',
    content: external
      ? 'В Platforma подходящего лота нет, но он найден на официальном сайте застройщика.'
      : 'Нашёл подтверждённую информацию по официальным данным.',
    facts: external ? [] : [{
      id: knowledgeId,
      label: knowledgeLabel,
      value: knowledgeValue,
      freshnessLabel: expected.freshnessRequired ? 'Обновлено сегодня' : '',
      isStale: false,
    }],
    externalLots: external ? [{
      id: knowledgeId,
      title: knowledgeLabel,
      subtitle: 'Застройщик',
      priceRub: 20_000_000,
      availabilityLabel: 'В продаже на официальном сайте',
      freshnessLabel: 'Обновлено сегодня',
      isStale: false,
      href: `https://developer.example/lots/${knowledgeId}`,
    }] : [],
  };
  const answer = answerKind === 'SEARCH_RESULTS'
    ? searchAnswer
    : answerKind === 'KNOWLEDGE_RESULTS'
      ? knowledgeAnswer
      : answerKind === 'CLARIFICATION'
        ? { kind: answerKind, content: expected.expectedIntent.clarificationQuestion }
        : answerKind === 'REFUSAL'
          ? {
            kind: answerKind,
            content: 'Не могу подтвердить подходящие предложения по текущим данным Platforma.',
          }
          : {
            kind: answerKind,
            content: [
              'Я могу помочь найти и сравнить объекты по подтверждённым данным Platforma,',
              'но ответ по налогам или правовым условиям не заменяет консультацию профильного специалиста.',
            ].join(' '),
          };
  const evidence = answerKind === 'SEARCH_RESULTS'
    ? [{
      evidenceType: 'PLATFORMA_FEED_UNIT',
      unitId: resultId,
      unitExternalId: expected.expectedUnitExternalId ?? `eval-${id.slice(-12)}`,
      objectId,
      objectType: 'RESIDENTIAL',
      objectTitle: 'Eval project',
      objectSlug: 'eval-project',
      lotTitle: result.title,
      priceRub: result.priceRub,
      availability: 'AVAILABLE',
      updatedAt: expected.staleLabelRequired
        ? new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000).toISOString()
        : now.toISOString(),
      rooms: expected.expectedIntent?.hardFilters?.rooms?.[0] ?? 2,
      district: 'Хамовники',
      metros: ['Спортивная'],
      developer: 'Eval developer',
      completionYear: 2027,
      completionQuarter: 3,
      propertyClass: 'Бизнес',
      area: 70,
      floor: expected.expectedIntent?.hardFilters?.floorMin ?? 8,
      pdfs: [],
      deviations: result.deviations,
      ...(expected.distanceRequired ? {
        latitude: geoPoint.latitude,
        longitude: geoPoint.longitude,
        distanceMeters: 900,
      } : {}),
    }]
    : answerKind === 'KNOWLEDGE_RESULTS'
      ? [{
        evidenceType: 'KNOWLEDGE_SOURCE',
        factId: knowledgeId,
        sourceId: `70000000-0000-4000-8000-${id.slice(-12)}`,
        sourceType: expected.sourcePriority === 'OFFICIAL_DEVELOPER_OR_BANK'
          || expected.deterministicSourcePriorityRequired
          ? 'DEVELOPER_PROMOTION'
          : 'DEVELOPMENT_PAGE',
        sourcePriority: 100,
        kind: expected.expectedKnowledge?.factKinds[0]
          ?? (external ? 'EXTERNAL_LOT' : 'ARCHITECTURE'),
        label: knowledgeLabel,
        projectKey: expected.expectedKnowledge?.projectKey ?? null,
        developerKey: null,
        canonicalUrl: external
          ? `https://developer.example/lots/${knowledgeId}`
          : 'https://developer.example/eval',
        value: external ? {
          title: knowledgeLabel,
          priceRub: 20_000_000,
          availability: 'AVAILABLE',
        } : knowledgeValue,
      }]
      : [];
  if (answerKind === 'SEARCH_RESULTS' && expected.expectedIntent?.taskType === 'COMPARE') {
    const [firstTarget, secondTarget] = expected.expectedIntent.comparisonTargets;
    result.title = firstTarget;
    result.subtitle = `ЖК ${firstTarget}`;
    result.href = `/objects/eval-comparison-1/lots/${resultId}`;
    evidence[0].objectTitle = firstTarget;
    evidence[0].objectSlug = 'eval-comparison-1';
    const secondResultId = `21000000-0000-4000-8000-${id.slice(-12)}`;
    searchAnswer.exactResults.push({
      ...result,
      unitId: secondResultId,
      title: secondTarget,
      subtitle: `ЖК ${secondTarget}`,
      href: `/objects/eval-comparison-2/lots/${secondResultId}`,
    });
    evidence.push({
      ...evidence[0],
      unitId: secondResultId,
      objectId: `61000000-0000-4000-8000-${id.slice(-12)}`,
      objectTitle: secondTarget,
      objectSlug: 'eval-comparison-2',
    });
  }
  const candidateSet = evidence.map((candidate) => ({
    evidenceId: candidate.unitId ?? candidate.factId,
    ...candidate,
    ...(candidate.factId ? { factKind: candidate.kind } : {}),
  }));
  const rankingDecisions = evidence.map((candidate) => ({
    evidenceId: candidate.unitId ?? candidate.factId,
    outcome: isAlternative ? 'ALTERNATIVE' : answerKind === 'KNOWLEDGE_RESULTS' ? 'SELECTED_FACT' : 'PRIMARY',
  }));
  if (expected.deterministicSourcePriorityRequired) {
    candidateSet.push({
      ...candidateSet[0],
      evidenceId: `31000000-0000-4000-8000-${id.slice(-12)}`,
      sourceId: `71000000-0000-4000-8000-${id.slice(-12)}`,
      sourceType: 'AGGREGATOR_CIAN',
      sourcePriority: 1,
      value: 'Устаревшее конфликтующее значение',
    });
    rankingDecisions.push({
      evidenceId: `31000000-0000-4000-8000-${id.slice(-12)}`,
      outcome: 'REJECTED',
    });
  }
  return {
    id,
    ownerUserId: '40000000-0000-4000-8000-000000000001',
    conversationOwnerUserId: '40000000-0000-4000-8000-000000000001',
    ownerPermissions: ['objects:read'],
    status: 'COMPLETED',
    createdAt: new Date(now.getTime() - 120_000).toISOString(),
    completedAt: new Date(now.getTime() - 60_000).toISOString(),
    query: item.query,
    context: null,
    geoContext: expected.expectedGeo ? {
      anchor: {
        latitude: expected.expectedGeo.latitude,
        longitude: expected.expectedGeo.longitude,
        label: expected.expectedGeo.anchorLabel,
        source: 'PLACE',
      },
      radiusMeters: expected.expectedGeo.radiusMeters,
    } : null,
    answer,
    evidence,
    intent: expected.expectedIntent ? structuredClone(expected.expectedIntent) : {
      taskType: 'SEARCH',
      comparisonTargets: [],
      hardFilters: emptySearchFilters(),
      softPreferences: emptySearchFilters(),
      requiredFacts: ['PRICE', 'AVAILABILITY', 'FRESHNESS', 'LINK'],
      needsClarification: false,
      clarificationQuestion: null,
    },
    audit: {
      schemaVersion: 1,
      candidateSet,
      rankingDecisions,
      evidenceRevisions: evidence.map((candidate) => ({ evidenceId: candidate.unitId ?? candidate.factId })),
      qualityFlags: [],
    },
    qualityFlags: [],
    latencyMs: 1_000,
    telemetry: [{ outcome: 'ACCEPTED', totalTokens: 500 }],
    geoProviderCalls: item.category === 'GEOSEARCH' ? 1 : 0,
  };
}

function breakEvalInvariant(records, cases, violation) {
  const expectationKey = violation === 'HARD_FILTER_VIOLATION'
    ? 'hardFiltersRequired'
    : violation === 'SOURCE_PRIORITY_VIOLATION'
      ? 'deterministicSourcePriorityRequired'
      : violation === 'INVENTED_PRICE_OR_AVAILABILITY'
        ? 'inventedFactsForbidden'
        : violation === 'UNSUPPORTED_LINK'
          ? 'externalHttpsLinkRequired'
          : null;
  const index = expectationKey
    ? cases.findIndex((item) => item.expected[expectationKey])
    : 0;
  const record = records[index];
  if (violation === 'AUTH_VIOLATION') record.ownerPermissions = [];
  if (violation === 'HARD_FILTER_VIOLATION') record.qualityFlags.push('HARD_FILTER_VIOLATION');
  if (violation === 'SOURCE_PRIORITY_VIOLATION') {
    record.evidence[0].sourceType = 'AGGREGATOR_CIAN';
    const selected = record.audit.candidateSet[0];
    selected.sourceType = 'AGGREGATOR_CIAN';
    selected.sourcePriority = 1;
    record.audit.candidateSet.push({
      ...selected,
      evidenceId: '50000000-0000-4000-8000-000000000001',
      sourceType: 'DEVELOPMENT_PAGE',
      sourcePriority: 100,
    });
    record.audit.rankingDecisions.push({
      evidenceId: '50000000-0000-4000-8000-000000000001',
      outcome: 'REJECTED',
    });
  }
  if (violation === 'INVENTED_PRICE_OR_AVAILABILITY') {
    const result = record.answer.exactResults?.[0] ?? record.answer.alternatives?.[0];
    if (result) result.priceRub += 1;
    else record.qualityFlags.push('UNSUPPORTED_FACT');
  }
  if (violation === 'UNSUPPORTED_LINK') record.qualityFlags.push('BROKEN_LINK');
  if (violation === 'EVIDENCE_LEAKAGE') record.answer.evidenceJson = record.evidence;
}

function emptySearchFilters() {
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

function projectNorth(latitude, longitude, meters) {
  return {
    latitude: latitude + meters / 6_371_000 * 180 / Math.PI,
    longitude,
  };
}

function rolloutApproval(stage, startedAt) {
  const userIds = Array.from({ length: 10 }, (_, index) => (
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  ));
  return {
    kind: 'ASSISTANT_ROLLOUT_PREFLIGHT',
    passed: true,
    currentStage: stage === 'PILOT' ? 'ADMINS' : 'PILOT',
    targetStage: stage,
    stageStartedAt: startedAt.toISOString(),
    eval: { version: 'assistant-eval-v1', passed: true, caseCount: 200 },
    sourceHealth: { passed: true, activeSourceCount: 1, unhealthySourceIds: [] },
    budgets: { passed: true, missing: [] },
    pilotCohort: {
      passed: true,
      configuredCount: 10,
      userIds,
      missingUserIds: [],
      ineligibleUserIds: [],
    },
    observation: {
      passed: true,
      runCount: 10,
      uniqueUserCount: 10,
      missingPilotUserIds: [],
      blockers: [],
    },
    criticalErrorCount: 0,
  };
}
