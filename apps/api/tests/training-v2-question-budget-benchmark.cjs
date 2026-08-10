if (process.env.OPENAI_QUESTION_BUDGET_BENCHMARK_ENABLED !== 'true') {
  console.log(JSON.stringify({
    status: 'skipped',
    reason: 'OPENAI_QUESTION_BUDGET_BENCHMARK_DISABLED',
    required: ['OPENAI_QUESTION_BUDGET_BENCHMARK_ENABLED=true'],
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
  const fixturePath = process.env.OPENAI_QUESTION_BUDGET_BENCHMARK_FIXTURE?.trim();
  if (
    process.env.TRAINING_AI_MODE !== 'openai' ||
    !process.env.OPENAI_API_KEY?.trim() ||
    !fixturePath
  ) {
    console.log(JSON.stringify({
      status: 'failure',
      failure: 'OPENAI_QUESTION_BUDGET_BENCHMARK_CONFIG_INVALID',
      required: [
        'TRAINING_AI_MODE=openai',
        'OPENAI_API_KEY',
        'OPENAI_QUESTION_BUDGET_BENCHMARK_FIXTURE',
      ],
    }));
    process.exitCode = 1;
    return;
  }

  const { createHash } = require('node:crypto');
  const { readFileSync } = require('node:fs');
  const {
    DEFAULT_OPENAI_QUESTION_GENERATION_MODEL,
    DEFAULT_OPENAI_QUESTION_GENERATION_REASONING,
    OpenAITrainingMaterialSuggester,
    prepareTrainingQuestionKnowledge,
    TRAINING_QUESTION_COMPILER_VERSION,
    TRAINING_QUESTION_PROMPT_VERSION,
  } = require('../dist/training/training-material-suggester.js');
  const {
    TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
  } = require('../dist/training/training-question-context-budget.js');
  const {
    TrainingOpenAIClient,
    TrainingOpenAIError,
  } = require('../dist/training/training-openai-client.js');

  const fixture = parseFixture(readFileSync(fixturePath, 'utf8'));
  const plans = [30_000, 24_000].map((sourceMaximumChars) => {
    const options = Object.freeze({ sourceMaximumChars });
    const prepared = prepareTrainingQuestionKnowledge(fixture, options);
    return Object.freeze({ sourceMaximumChars, prepared });
  });

  for (const plan of plans) {
    if (plan.prepared.evidenceMetrics.representedSources !==
      plan.prepared.evidenceMetrics.uniqueSources) {
      throw new TrainingOpenAIError('QUESTION_BUDGET_SOURCE_COVERAGE_FAILED', false);
    }
  }
  const contextDigests = plans.map(({ prepared }) => createHash('sha256')
    .update(JSON.stringify(prepared.segments))
    .digest('hex'));
  if (contextDigests[0] === contextDigests[1]) {
    console.log(JSON.stringify({
      status: 'skipped',
      reason: 'QUESTION_BUDGET_CONTEXTS_IDENTICAL',
      evidence: plans[0].prepared.evidenceMetrics,
    }));
    return;
  }

  const client = new TrainingOpenAIClient(process.env.OPENAI_API_KEY);
  const suggester = new OpenAITrainingMaterialSuggester(client);
  const variants = [];

  for (const plan of plans) {
    const observations = [];
    const startedAt = Date.now();
    const options = Object.freeze({
      sourceMaximumChars: plan.sourceMaximumChars,
      preparedSource: plan.prepared,
      observeResponse: (observation) => observations.push(observation),
    });
    const result = await suggester.generateQuestionDrafts(fixture, options);
    variants.push(createVariantReport(
      plan,
      result,
      observations,
      Math.max(0, Date.now() - startedAt),
    ));
  }

  console.log(JSON.stringify({
    status: 'success',
    benchmark: 'training-question-context-budget-30k-vs-24k',
    execution: 'sequential',
    maxProviderAttempts: 4,
    sharedContract: {
      requestedModel: process.env.OPENAI_QUESTION_GENERATION_MODEL ??
        DEFAULT_OPENAI_QUESTION_GENERATION_MODEL,
      reasoning: process.env.OPENAI_QUESTION_GENERATION_REASONING ??
        DEFAULT_OPENAI_QUESTION_GENERATION_REASONING,
      compilerVersion: TRAINING_QUESTION_COMPILER_VERSION,
      promptVersion: TRAINING_QUESTION_PROMPT_VERSION,
      budgetPolicyVersion: TRAINING_QUESTION_CONTEXT_BUDGET_POLICY_VERSION,
    },
    variants,
    decision: {
      productionDefaultChanged: false,
      manualQualityReviewRequired: true,
    },
  }));
}

function parseFixture(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('OPENAI_QUESTION_BUDGET_BENCHMARK_FIXTURE_INVALID');
  }
  if (
    !isRecord(value) ||
    typeof value.objectTitle !== 'string' ||
    !value.objectTitle.trim() ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0
  ) {
    throw new Error('OPENAI_QUESTION_BUDGET_BENCHMARK_FIXTURE_INVALID');
  }
  return {
    projectId: 'question-budget-benchmark',
    objectId: 'question-budget-benchmark-object',
    objectTitle: value.objectTitle,
    sources: value.sources,
  };
}

function createVariantReport(plan, result, observations, latencyMs) {
  const questions = [result.main, ...result.followUps];
  const facts = questions.flatMap((question) => question.facts);
  const normalizedQuestions = questions.map((question) => question.text
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('ru-RU'));
  const uniqueQuestions = new Set(normalizedQuestions);
  const referencedLocators = new Set(facts.map((fact) => fact.sourceLocator));
  const usage = sumObservedUsage(observations);
  const actualModels = [...new Set(observations
    .map((observation) => observation.model)
    .filter((model) => typeof model === 'string'))];

  return {
    budget: {
      configuredMaximum: plan.sourceMaximumChars,
      chosenBudget: plan.prepared.evidenceMetrics.chosenBudget,
      policyVersion: plan.prepared.evidenceMetrics.policyVersion,
    },
    evidence: plan.prepared.evidenceMetrics,
    provider: {
      requestedModel: result.model,
      actualModels,
      ...usage,
      latencyMs,
      attempts: result.attempts,
      retryCount: Math.max(0, result.attempts - 1),
      ...estimateStandardShortContextCost(actualModels, usage),
    },
    validation: {
      valid: questions.length === 11 && result.followUps.length === 10,
      mainQuestions: 1,
      followUpQuestions: result.followUps.length,
      totalQuestions: questions.length,
    },
    grounding: {
      factCount: facts.length,
      groundedFactCount: facts.length,
      uniqueReferencedLocators: referencedLocators.size,
      invalidLocatorCount: 0,
    },
    coverage: {
      inputSourceRepresentationRatio: ratio(
        plan.prepared.evidenceMetrics.representedSources,
        plan.prepared.evidenceMetrics.uniqueSources,
      ),
      outputSelectedEvidenceReferenceRatio: ratio(
        referencedLocators.size,
        plan.prepared.evidenceMetrics.selectedFragments,
      ),
    },
    duplicateQuestions: {
      exactCount: normalizedQuestions.length - uniqueQuestions.size,
    },
    manualQuality: {
      status: 'pending',
      rubricVersion: 'training-question-budget-review-v1',
      answerability: null,
      groundedness: null,
      coverage: null,
      questionDiversity: null,
      brokerUsefulness: null,
      semanticDuplicateCount: null,
      preferredBudget: null,
      decision: null,
    },
  };
}

function sumObservedUsage(observations) {
  const keys = [
    'inputTokens',
    'cachedTokens',
    'cacheWriteTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
  ];
  return Object.fromEntries(keys.map((key) => [
    key,
    observations.length > 0 && observations.every((item) =>
      Number.isInteger(item.usage?.[key]),
    )
      ? observations.reduce((total, item) => total + item.usage[key], 0)
      : null,
  ]));
}

function estimateStandardShortContextCost(actualModels, usage) {
  const pricing = {
    model: 'gpt-5.6-terra',
    snapshot: '2026-08-07-standard-short-context',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    cacheWriteUsdPerMillion: 2.5,
    outputUsdPerMillion: 12,
  };
  const complete = [
    usage.inputTokens,
    usage.cachedTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
  ].every(Number.isInteger);
  if (!complete || actualModels.length !== 1 || actualModels[0] !== pricing.model) {
    return {
      estimatedCostUsd: null,
      pricingSnapshot: pricing.snapshot,
      pricingStatus: complete ? 'actual_model_mismatch' : 'usage_incomplete',
    };
  }
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens,
  );
  const cost = (
    uncachedInput * pricing.inputUsdPerMillion +
    usage.cachedTokens * pricing.cachedInputUsdPerMillion +
    usage.cacheWriteTokens * pricing.cacheWriteUsdPerMillion +
    usage.outputTokens * pricing.outputUsdPerMillion
  ) / 1_000_000;
  return {
    estimatedCostUsd: Number(cost.toFixed(8)),
    pricingSnapshot: pricing.snapshot,
    pricingStatus: 'estimated',
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function safeFailureCode(error) {
  if (error && error.name === 'TrainingOpenAIError' && typeof error.code === 'string') {
    return error.code.slice(0, 120);
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,120}$/u.test(error.message)) {
    return error.message;
  }
  return 'OPENAI_QUESTION_BUDGET_BENCHMARK_FAILED';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
