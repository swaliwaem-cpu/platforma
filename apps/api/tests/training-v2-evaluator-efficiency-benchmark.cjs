if (process.env.OPENAI_EVALUATOR_BENCHMARK_ENABLED !== 'true') {
  console.log(JSON.stringify({
    status: 'skipped',
    reason: 'OPENAI_EVALUATOR_BENCHMARK_DISABLED',
    required: ['OPENAI_EVALUATOR_BENCHMARK_ENABLED=true'],
  }));
  process.exit(0);
}

void run().catch((error) => {
  console.log(JSON.stringify({
    status: 'failure',
    failure: safeFailureCode(error),
  }));
  process.exitCode = 1;
});

async function run() {
  const { readFileSync } = require('node:fs');
  const fixturePath = process.env.OPENAI_EVALUATOR_BENCHMARK_FIXTURE?.trim();
  if (
    process.env.TRAINING_AI_MODE !== 'openai' ||
    !process.env.OPENAI_API_KEY?.trim() ||
    !fixturePath
  ) {
    throw new Error('OPENAI_EVALUATOR_BENCHMARK_CONFIG_INVALID');
  }

  const fixture = parseFixture(readFileSync(fixturePath, 'utf8'));
  const candidate = readCandidate();
  const {
    calculateTrainingObjectiveMetrics,
    scoreTrainingEvaluation,
  } = require('../dist/training/training-evaluator.js');
  const { OpenAITrainingEvaluator } = require('../dist/training/training-openai-evaluator.js');
  const {
    TrainingOpenAIClient,
    TrainingOpenAIError,
  } = require('../dist/training/training-openai-client.js');
  const maximumProviderCalls = fixture.cases.length * 4;
  let providerCalls = 0;
  const providerClient = new TrainingOpenAIClient(process.env.OPENAI_API_KEY);
  const boundedClient = {
    request(input) {
      providerCalls += 1;
      if (providerCalls > maximumProviderCalls) {
        throw new TrainingOpenAIError('OPENAI_EVALUATOR_BENCHMARK_CALL_LIMIT', false);
      }
      return providerClient.request(input);
    },
  };
  const observations = [];
  const evaluator = new OpenAITrainingEvaluator(boundedClient, {
    async record(value) {
      observations.push(value);
      return true;
    },
  });
  evaluator.logger = { log: () => undefined };
  const environmentKeys = [
    'OPENAI_EVALUATOR_MAIN_REASONING',
    'OPENAI_EVALUATOR_FOLLOW_UP_REASONING',
    'OPENAI_EVALUATION_MAX_OUTPUT_TOKENS',
    'OPENAI_EVALUATION_EVIDENCE_MAX_CHARS',
    'OPENAI_EVALUATION_EXPLANATION_MAX_CHARS',
    'OPENAI_EVALUATION_SUMMARY_MAX_CHARS',
    'OPENAI_EVALUATION_UNSUPPORTED_CLAIMS_MAX',
    'OPENAI_EVALUATION_UNSUPPORTED_CLAIM_MAX_CHARS',
    'OPENAI_EVALUATION_MAX_RETRIES',
  ];
  const previousEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  const variants = [
    {
      name: 'baseline',
      config: {
        mainReasoning: 'medium',
        followUpReasoning: 'medium',
        maximumOutputTokens: 4_000,
        evidenceMaxChars: 500,
        explanationMaxChars: 1_000,
        summaryMaxChars: 1_000,
        unsupportedClaimsMax: 20,
        unsupportedClaimMaxChars: 500,
      },
    },
    { name: 'candidate', config: candidate },
  ];
  const reports = [];

  try {
    process.env.OPENAI_EVALUATION_MAX_RETRIES = '0';
    for (const variant of variants) {
      applyVariant(variant.config);
      const cases = [];
      for (const [index, fixtureCase] of fixture.cases.entries()) {
        const observationsStart = observations.length;
        const startedAt = Date.now();
        let result = null;
        let failure = null;
        let scoring = null;
        try {
          const evaluationInput = createEvaluationInput(
            fixtureCase,
            index,
            calculateTrainingObjectiveMetrics,
          );
          result = await evaluator.evaluate(evaluationInput);
          scoring = scoreTrainingEvaluation(result.evaluation, evaluationInput);
        } catch (error) {
          failure = safeFailureCode(error);
        }
        const attempts = observations.slice(observationsStart);
        cases.push({
          caseId: `case-${String(index + 1).padStart(2, '0')}`,
          status: result ? 'accepted' : 'failed',
          failure,
          providerAttempts: attempts.length,
          extraCalls: Math.max(0, attempts.length - 1),
          latencyMs: Math.max(0, Date.now() - startedAt),
          outputTokens: sumReported(attempts, 'outputTokens'),
          reasoningTokens: sumReported(attempts, 'reasoningTokens'),
          scoreAgreement: scoring
            ? scoring.score >= fixtureCase.expected.scoreMin &&
              scoring.score <= fixtureCase.expected.scoreMax
            : false,
          reviewAgreement: scoring
            ? scoring.requiresReview === fixtureCase.expected.requiresReview
            : false,
          contradictionAgreement: result
            ? detectsMaterialContradiction(result.evaluation) ===
              fixtureCase.expected.materialContradiction
            : false,
          automaticScoringAgreement: scoring
            ? !scoring.requiresReview === fixtureCase.expected.automaticScoringAllowed
            : false,
          materialErrorFalseNegative: result
            ? fixtureCase.expected.materialContradiction &&
              !detectsMaterialContradiction(result.evaluation)
            : fixtureCase.expected.materialContradiction,
        });
      }
      reports.push({
        name: variant.name,
        config: variant.config,
        summary: summarize(cases),
        cases,
      });
    }
  } finally {
    for (const key of environmentKeys) restoreEnvironment(key, previousEnvironment[key]);
  }

  console.log(JSON.stringify({
    status: 'success',
    benchmark: 'training-evaluator-efficiency-v1',
    execution: 'sequential',
    cases: fixture.cases.length,
    maximumProviderCalls,
    actualProviderCalls: providerCalls,
    variants: reports,
    decision: {
      productionDefaultsChanged: false,
      manualQualityReviewRequired: true,
      candidatePassesAutomaticGate:
        reports[1].summary.manualAgreementRate >= reports[0].summary.manualAgreementRate &&
        reports[1].summary.materialErrorFalseNegatives === 0 &&
        reports[1].summary.accepted === reports[0].summary.accepted &&
        reports[1].summary.latencyP95Ms < reports[0].summary.latencyP95Ms &&
        reports[1].summary.averageOutputTokens !== null &&
        reports[0].summary.averageOutputTokens !== null &&
        reports[1].summary.averageOutputTokens < reports[0].summary.averageOutputTokens,
    },
  }));
}

function parseFixture(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('OPENAI_EVALUATOR_BENCHMARK_FIXTURE_INVALID');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !Array.isArray(value.cases) ||
    value.cases.length < 2 ||
    value.cases.length > 10
  ) {
    throw new Error('OPENAI_EVALUATOR_BENCHMARK_FIXTURE_INVALID');
  }
  for (const item of value.cases) validateFixtureCase(item);
  return value;
}

function validateFixtureCase(value) {
  if (
    !isRecord(value) ||
    !['MAIN', 'FOLLOW_UP'].includes(value.questionType) ||
    typeof value.questionText !== 'string' ||
    !value.questionText.trim() ||
    typeof value.transcript !== 'string' ||
    !value.transcript.trim() ||
    !Array.isArray(value.facts) ||
    value.facts.length < 1 ||
    value.facts.length > 3 ||
    !Array.isArray(value.criteria) ||
    value.criteria.length < 1 ||
    !Number.isInteger(value.audioDurationSeconds) ||
    value.audioDurationSeconds < 1 ||
    !Number.isInteger(value.segmentCount) ||
    value.segmentCount < 1 ||
    !Number.isInteger(value.maxScore) ||
    !isRecord(value.expected) ||
    !Number.isInteger(value.expected.scoreMin) ||
    !Number.isInteger(value.expected.scoreMax) ||
    value.expected.scoreMin < 0 ||
    value.expected.scoreMax < value.expected.scoreMin ||
    value.expected.scoreMax > value.maxScore ||
    typeof value.expected.requiresReview !== 'boolean' ||
    typeof value.expected.materialContradiction !== 'boolean' ||
    typeof value.expected.automaticScoringAllowed !== 'boolean' ||
    value.expected.automaticScoringAllowed === value.expected.requiresReview
  ) {
    throw new Error('OPENAI_EVALUATOR_BENCHMARK_FIXTURE_INVALID');
  }
}

function readCandidate() {
  return {
    mainReasoning: readReasoning('OPENAI_EVALUATOR_BENCHMARK_MAIN_REASONING'),
    followUpReasoning: readReasoning('OPENAI_EVALUATOR_BENCHMARK_FOLLOW_UP_REASONING'),
    maximumOutputTokens: readInteger(
      'OPENAI_EVALUATOR_BENCHMARK_MAX_OUTPUT_TOKENS', 500, 4_000,
    ),
    evidenceMaxChars: readInteger(
      'OPENAI_EVALUATOR_BENCHMARK_EVIDENCE_MAX_CHARS', 80, 500,
    ),
    explanationMaxChars: readInteger(
      'OPENAI_EVALUATOR_BENCHMARK_EXPLANATION_MAX_CHARS', 80, 1_000,
    ),
    summaryMaxChars: readInteger(
      'OPENAI_EVALUATOR_BENCHMARK_SUMMARY_MAX_CHARS', 80, 1_000,
    ),
    unsupportedClaimsMax: readInteger(
      'OPENAI_EVALUATOR_BENCHMARK_UNSUPPORTED_CLAIMS_MAX', 0, 20,
    ),
    unsupportedClaimMaxChars: readInteger(
      'OPENAI_EVALUATOR_BENCHMARK_UNSUPPORTED_CLAIM_MAX_CHARS', 80, 500,
    ),
  };
}

function createEvaluationInput(item, index, calculateTrainingObjectiveMetrics) {
  return {
    projectId: `evaluator-benchmark-project-${index + 1}`,
    attemptId: `evaluator-benchmark-attempt-${index + 1}`,
    questionId: `evaluator-benchmark-question-${index + 1}`,
    projectKnowledgeVersion: 1,
    questionText: item.questionText,
    questionType: item.questionType,
    transcript: item.transcript,
    facts: item.facts,
    criteria: item.criteria,
    objectiveMetrics: calculateTrainingObjectiveMetrics({
      transcript: item.transcript,
      audioDurationSeconds: item.audioDurationSeconds,
      segmentCount: item.segmentCount,
    }),
    maxScore: item.maxScore,
    evaluationSchemaVersion: 'training-v2-evaluation-v2',
    harmlessExtraRoutingEnabled: true,
  };
}

function applyVariant(value) {
  process.env.OPENAI_EVALUATOR_MAIN_REASONING = value.mainReasoning;
  process.env.OPENAI_EVALUATOR_FOLLOW_UP_REASONING = value.followUpReasoning;
  process.env.OPENAI_EVALUATION_MAX_OUTPUT_TOKENS = String(value.maximumOutputTokens);
  process.env.OPENAI_EVALUATION_EVIDENCE_MAX_CHARS = String(value.evidenceMaxChars);
  process.env.OPENAI_EVALUATION_EXPLANATION_MAX_CHARS = String(value.explanationMaxChars);
  process.env.OPENAI_EVALUATION_SUMMARY_MAX_CHARS = String(value.summaryMaxChars);
  process.env.OPENAI_EVALUATION_UNSUPPORTED_CLAIMS_MAX = String(value.unsupportedClaimsMax);
  process.env.OPENAI_EVALUATION_UNSUPPORTED_CLAIM_MAX_CHARS =
    String(value.unsupportedClaimMaxChars);
}

function summarize(cases) {
  const accepted = cases.filter((item) => item.status === 'accepted');
  const agreement = cases.filter((item) =>
    item.scoreAgreement &&
    item.reviewAgreement &&
    item.contradictionAgreement &&
    item.automaticScoringAgreement
  ).length;
  const providerAttempts = cases.reduce((total, item) => total + item.providerAttempts, 0);
  const extraCalls = cases.reduce((total, item) => total + item.extraCalls, 0);
  const outputTokens = cases.map((item) => item.outputTokens).filter(Number.isInteger);
  const reasoningTokens = cases.map((item) => item.reasoningTokens).filter(Number.isInteger);
  return {
    accepted: accepted.length,
    failed: cases.length - accepted.length,
    manualAgreementRate: ratio(agreement, cases.length),
    retryRate: ratio(cases.filter((item) => item.extraCalls > 0).length, cases.length),
    extraCallRatio: ratio(extraCalls, cases.length),
    providerAttempts,
    averageOutputTokens: average(outputTokens),
    averageReasoningTokens: average(reasoningTokens),
    latencyP95Ms: percentile(cases.map((item) => item.latencyMs), 0.95),
    materialErrorFalseNegatives: cases.filter((item) => item.materialErrorFalseNegative).length,
  };
}

function detectsMaterialContradiction(evaluation) {
  return evaluation.fact_assessments.some((assessment) => assessment.verdict === 'INCORRECT') ||
    evaluation.unsupported_claims.some((claim) => claim.category === 'CONTRADICTORY');
}

function sumReported(attempts, key) {
  const values = attempts.map((item) => item.usage?.[key]).filter(Number.isInteger);
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null;
}

function average(values) {
  return values.length > 0
    ? Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 10) / 10
    : null;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

function readReasoning(name) {
  const value = process.env[name]?.trim();
  if (!['low', 'medium', 'high'].includes(value)) {
    throw new Error('OPENAI_EVALUATOR_BENCHMARK_CANDIDATE_INVALID');
  }
  return value;
}

function readInteger(name, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('OPENAI_EVALUATOR_BENCHMARK_CANDIDATE_INVALID');
  }
  return value;
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function safeFailureCode(error) {
  if (error && error.name === 'TrainingOpenAIError' && typeof error.code === 'string') {
    return error.code.slice(0, 120);
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,120}$/u.test(error.message)) {
    return error.message;
  }
  return 'OPENAI_EVALUATOR_BENCHMARK_FAILED';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
