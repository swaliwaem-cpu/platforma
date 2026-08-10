if (process.env.OPENAI_LUNA_TERRA_BENCHMARK_ENABLED !== 'true') {
  console.log(JSON.stringify({
    status: 'skipped',
    reason: 'OPENAI_LUNA_TERRA_BENCHMARK_DISABLED',
    required: ['OPENAI_LUNA_TERRA_BENCHMARK_ENABLED=true'],
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
  const { createHash } = require('node:crypto');
  const { readFileSync } = require('node:fs');
  const fixturePath = process.env.OPENAI_LUNA_TERRA_BENCHMARK_FIXTURE?.trim();
  const pricingPath = process.env.OPENAI_LUNA_TERRA_BENCHMARK_PRICING?.trim();
  const maximumUsd = Number(process.env.OPENAI_LUNA_TERRA_BENCHMARK_MAX_USD);
  if (
    process.env.TRAINING_AI_MODE !== 'openai' ||
    !process.env.OPENAI_API_KEY?.trim() ||
    !fixturePath ||
    !pricingPath ||
    !Number.isFinite(maximumUsd) ||
    maximumUsd <= 0 ||
    maximumUsd > 12
  ) {
    throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_CONFIG_INVALID');
  }

  const fixture = parseFixture(readFileSync(fixturePath, 'utf8'));
  const pricing = parsePricingSnapshot(readFileSync(pricingPath, 'utf8'));
  const {
    OpenAITrainingMaterialSuggester,
    prepareTrainingQuestionKnowledge,
  } = require('../dist/training/training-material-suggester.js');
  const {
    TrainingOpenAIClient,
    TrainingOpenAIError,
  } = require('../dist/training/training-openai-client.js');
  const providerClient = new TrainingOpenAIClient(process.env.OPENAI_API_KEY);
  const client = createRequestSizeBoundClient(providerClient, TrainingOpenAIError);
  const suggester = new OpenAITrainingMaterialSuggester(client);
  const environmentKeys = [
    'OPENAI_QUESTION_GENERATION_STRATEGY',
    'OPENAI_QUESTION_GENERATION_MODEL',
    'OPENAI_QUESTION_GENERATION_LUNA_MODEL',
    'OPENAI_QUESTION_GENERATION_REASONING',
    'OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS',
    'OPENAI_QUESTION_GENERATION_MAX_OUTPUT_TOKENS',
  ];
  const previousEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  process.env.OPENAI_QUESTION_GENERATION_MODEL = 'gpt-5.6-terra';
  process.env.OPENAI_QUESTION_GENERATION_LUNA_MODEL = 'gpt-5.6-luna';
  process.env.OPENAI_QUESTION_GENERATION_REASONING = 'low';
  process.env.OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS = '30000';
  process.env.OPENAI_QUESTION_GENERATION_MAX_OUTPUT_TOKENS = '7000';

  const cases = [];
  let budgetDebitedUsd = 0;
  try {
    for (const [caseIndex, fixtureCase] of fixture.objects.entries()) {
      const caseId = `case-${String(caseIndex + 1).padStart(2, '0')}`;
      const input = {
        projectId: `luna-terra-benchmark-${caseId}`,
        objectId: `luna-terra-benchmark-object-${caseId}`,
        objectTitle: fixtureCase.objectTitle,
        sources: fixtureCase.sources,
      };
      const variants = [];
      for (const strategy of ['terra_only', 'luna_then_terra']) {
        const maximumCompilationCost = maximumCostForCompilation(pricing, strategy);
        if (budgetDebitedUsd + maximumCompilationCost > maximumUsd) {
          throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_BUDGET_WOULD_EXCEED');
        }
        process.env.OPENAI_QUESTION_GENERATION_STRATEGY = strategy;
        const prepared = prepareTrainingQuestionKnowledge(input);
        const observations = [];
        const startedAt = Date.now();
        let result = null;
        let failure = null;
        try {
          result = await suggester.generateQuestionDrafts(input, {
            preparedSource: prepared,
            observeResponse: (observation) => observations.push(observation),
          });
        } catch (error) {
          failure = safeFailureCode(error);
        }
        const attemptReports = observations.map((observation) =>
          createAttemptReport(observation, pricing),
        );
        const compilationDebit = attemptReports.reduce(
          (total, attempt) => total + (
            attempt.estimatedCostUsd ?? maximumCostForModel(pricing, attempt.requestedModel)
          ),
          0,
        );
        budgetDebitedUsd += compilationDebit;
        if (budgetDebitedUsd > maximumUsd) {
          throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_BUDGET_EXCEEDED');
        }
        variants.push(createVariantReport({
          strategy,
          prepared,
          result,
          failure,
          observations: attemptReports,
          latencyMs: Math.max(0, Date.now() - startedAt),
          createHash,
          compilationDebit,
        }));
      }
      cases.push({
        caseId,
        profile: fixtureCase.profile,
        input: {
          canonicalSources: prepareTrainingQuestionKnowledge(input).sourceManifest.length,
          sourceRevisions: fixtureCase.sources.length,
          sourceChars: fixtureCase.sources.reduce(
            (total, source) => total + source.segments.reduce(
              (subtotal, segment) => subtotal + segment.text.length,
              0,
            ),
            0,
          ),
        },
        variants,
      });
    }
  } finally {
    for (const key of environmentKeys) restoreEnvironment(key, previousEnvironment[key]);
  }

  const allVariants = cases.flatMap((item) => item.variants);
  const knownEstimatedCost = allVariants.reduce(
    (total, variant) => total + variant.provider.knownEstimatedCostUsd,
    0,
  );
  console.log(JSON.stringify({
    status: 'success',
    benchmark: 'training-question-generation-luna-vs-terra-v1',
    execution: 'sequential',
    cases: cases.length,
    maxHttpAttemptsPerCompilation: 2,
    maxProviderAttempts: 40,
    productionDefaultChanged: false,
    pricing: {
      snapshotId: pricing.snapshotId,
      sourceUrl: pricing.sourceUrl,
      maximumUsd,
      knownEstimatedCostUsd: roundUsd(knownEstimatedCost),
      conservativeBudgetDebitUsd: roundUsd(budgetDebitedUsd),
    },
    summary: summarize(allVariants),
    results: cases,
    manualQuality: {
      status: 'pending',
      rubricVersion: 'training-question-luna-terra-manual-review-v1',
      required: [
        'factual_grounding',
        'semantic_duplicates',
        'broker_usefulness',
        'terra_comparable_coverage',
      ],
    },
  }));
}

function parseFixture(raw) {
  const value = parseJson(raw, 'OPENAI_LUNA_TERRA_BENCHMARK_FIXTURE_INVALID');
  if (!isRecord(value) || !Array.isArray(value.objects) || value.objects.length !== 10) {
    throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_FIXTURE_INVALID');
  }
  const objects = value.objects.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.objectTitle !== 'string' ||
      !item.objectTitle.trim() ||
      item.objectTitle.length > 500 ||
      !isRecord(item.profile) ||
      !['small', 'medium', 'large'].includes(item.profile.size) ||
      typeof item.profile.multipleDocuments !== 'boolean' ||
      typeof item.profile.numericTechnicalFacts !== 'boolean' ||
      typeof item.profile.similarSections !== 'boolean' ||
      !Array.isArray(item.sources) ||
      item.sources.length === 0
    ) {
      throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_FIXTURE_INVALID');
    }
    return {
      objectTitle: item.objectTitle,
      profile: {
        size: item.profile.size,
        multipleDocuments: item.profile.multipleDocuments,
        numericTechnicalFacts: item.profile.numericTechnicalFacts,
        similarSections: item.profile.similarSections,
      },
      sources: item.sources,
    };
  });
  const sizeCounts = Object.fromEntries(['small', 'medium', 'large'].map((size) => [
    size,
    objects.filter((item) => item.profile.size === size).length,
  ]));
  if (
    Object.values(sizeCounts).some((count) => count < 2) ||
    !objects.some((item) => item.profile.multipleDocuments) ||
    !objects.some((item) => item.profile.numericTechnicalFacts) ||
    !objects.some((item) => item.profile.similarSections)
  ) {
    throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_FIXTURE_NOT_REPRESENTATIVE');
  }
  return { objects };
}

function parsePricingSnapshot(raw) {
  const value = parseJson(raw, 'OPENAI_LUNA_TERRA_BENCHMARK_PRICING_INVALID');
  if (
    !isRecord(value) ||
    typeof value.snapshotId !== 'string' ||
    value.sourceUrl !== 'https://developers.openai.com/api/docs/pricing' ||
    value.currency !== 'USD' ||
    !Number.isInteger(value.shortContextMaximumInputTokens) ||
    value.shortContextMaximumInputTokens !== 272000 ||
    !isRecord(value.models) ||
    Object.keys(value.models).sort().join(',') !== 'gpt-5.6-luna,gpt-5.6-terra'
  ) {
    throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_PRICING_INVALID');
  }
  for (const model of Object.values(value.models)) {
    if (!isRecord(model) || Object.keys(model).sort().join(',') !== 'long,short') {
      throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_PRICING_INVALID');
    }
    for (const tier of Object.values(model)) {
      if (
        !isRecord(tier) ||
        Object.keys(tier).sort().join(',') !== [
          'cacheWriteUsdPerMillion',
          'cachedInputUsdPerMillion',
          'inputUsdPerMillion',
          'outputUsdPerMillion',
        ].join(',') ||
        Object.values(tier).some((price) => typeof price !== 'number' || price < 0)
      ) {
        throw new Error('OPENAI_LUNA_TERRA_BENCHMARK_PRICING_INVALID');
      }
    }
  }
  return value;
}

function createAttemptReport(observation, pricing) {
  const requestedModel = observation.requestedModel;
  const actualModel = observation.model ?? requestedModel;
  return {
    attempt: observation.attempt,
    requestedModel,
    actualModel,
    clientRequestId: observation.clientRequestId,
    requestId: observation.requestId,
    responseId: observation.responseId,
    outcome: observation.outcome,
    fallbackReason: observation.fallbackReason,
    finalModel: observation.finalModel,
    latencyMs: observation.durationMs,
    usage: observation.usage,
    ...estimateCost(pricing, actualModel, observation.usage),
  };
}

function createVariantReport(input) {
  const knownEstimatedCost = input.observations.reduce(
    (total, attempt) => total + (attempt.estimatedCostUsd ?? 0),
    0,
  );
  if (!input.result) {
    return {
      strategy: input.strategy,
      status: 'rejected',
      failure: input.failure,
      provider: {
        attempts: input.observations.length,
        latencyMs: input.latencyMs,
        knownEstimatedCostUsd: roundUsd(knownEstimatedCost),
        conservativeBudgetDebitUsd: roundUsd(input.compilationDebit),
        telemetry: input.observations,
      },
      validation: null,
    };
  }
  const questions = [input.result.main, ...input.result.followUps];
  const facts = questions.flatMap((question) => question.facts);
  const normalizedQuestions = questions.map((question) => question.text
    .normalize('NFC').trim().toLocaleLowerCase('ru-RU'));
  const canonicalSources = new Set(facts.map((fact) =>
    input.prepared.references.get(fact.sourceLocator)?.canonicalSourceKey,
  ).filter(Boolean));
  return {
    strategy: input.strategy,
    status: 'accepted',
    failure: null,
    provider: {
      attempts: input.observations.length,
      finalModel: input.result.model,
      latencyMs: input.latencyMs,
      knownEstimatedCostUsd: roundUsd(knownEstimatedCost),
      conservativeBudgetDebitUsd: roundUsd(input.compilationDebit),
      telemetry: input.observations,
    },
    validation: {
      mainQuestions: 1,
      followUpQuestions: input.result.followUps.length,
      totalQuestions: questions.length,
      factCount: facts.length,
      exactDuplicateQuestions: normalizedQuestions.length - new Set(normalizedQuestions).size,
      coveredCanonicalSources: canonicalSources.size,
      requiredCanonicalSources: Math.min(3, input.prepared.sourceManifest.length),
      questionDigests: questions.map((question) => input.createHash('sha256')
        .update(question.text.normalize('NFC').trim())
        .digest('hex').substring(0, 16)),
    },
  };
}

function estimateCost(pricing, model, usage) {
  if (!isCompleteUsage(usage) || !pricing.models[model]) {
    return {
      estimatedCostUsd: null,
      pricingStatus: isCompleteUsage(usage) ? 'actual_model_unknown' : 'usage_incomplete',
      pricingSnapshot: pricing.snapshotId,
    };
  }
  const tier = usage.inputTokens <= pricing.shortContextMaximumInputTokens
    ? pricing.models[model].short
    : pricing.models[model].long;
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens,
  );
  const cost = (
    uncachedInput * tier.inputUsdPerMillion +
    usage.cachedTokens * tier.cachedInputUsdPerMillion +
    usage.cacheWriteTokens * tier.cacheWriteUsdPerMillion +
    usage.outputTokens * tier.outputUsdPerMillion
  ) / 1_000_000;
  return {
    estimatedCostUsd: roundUsd(cost),
    pricingStatus: 'estimated',
    pricingSnapshot: pricing.snapshotId,
  };
}

function maximumCostForCompilation(pricing, strategy) {
  const terra = maximumCostForModel(pricing, 'gpt-5.6-terra');
  if (strategy === 'terra_only') return terra * 2;
  const luna = maximumCostForModel(pricing, 'gpt-5.6-luna');
  return Math.max(luna * 2, luna + terra);
}

function maximumCostForModel(pricing, model) {
  const tier = pricing.models[model].short;
  const maximumInputPrice = Math.max(
    tier.inputUsdPerMillion,
    tier.cachedInputUsdPerMillion,
    tier.cacheWriteUsdPerMillion,
  );
  return (100000 * maximumInputPrice + 7000 * tier.outputUsdPerMillion) / 1_000_000;
}

function createRequestSizeBoundClient(client, TrainingOpenAIError) {
  return {
    request: (input) => {
      if (
        typeof input.body !== 'string' ||
        Buffer.byteLength(input.body, 'utf8') > 100000
      ) {
        throw new TrainingOpenAIError(
          'OPENAI_LUNA_TERRA_BENCHMARK_REQUEST_TOO_LARGE',
          false,
        );
      }
      return client.request(input);
    },
  };
}

function summarize(variants) {
  const byStrategy = {};
  for (const strategy of ['terra_only', 'luna_then_terra']) {
    const selected = variants.filter((variant) => variant.strategy === strategy);
    const accepted = selected.filter((variant) => variant.status === 'accepted');
    const knownCost = selected.reduce(
      (total, variant) => total + variant.provider.knownEstimatedCostUsd,
      0,
    );
    byStrategy[strategy] = {
      compilations: selected.length,
      accepted: accepted.length,
      rejected: selected.length - accepted.length,
      providerAttempts: selected.reduce((total, variant) => total + variant.provider.attempts, 0),
      terraFallbacks: selected.reduce((total, variant) => total +
        variant.provider.telemetry.filter((attempt) =>
          attempt.fallbackReason === 'luna_local_validation_failed',
        ).length, 0),
      knownEstimatedCostUsd: roundUsd(knownCost),
      costPerAcceptedCompilationUsd: accepted.length > 0
        ? roundUsd(knownCost / accepted.length)
        : null,
    };
  }
  return byStrategy;
}

function isCompleteUsage(usage) {
  return isRecord(usage) && [
    'inputTokens',
    'cachedTokens',
    'cacheWriteTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
  ].every((key) => Number.isInteger(usage[key]) && usage[key] >= 0);
}

function parseJson(raw, errorCode) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(errorCode);
  }
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function roundUsd(value) {
  return Number(value.toFixed(8));
}

function safeFailureCode(error) {
  if (error && error.name === 'TrainingOpenAIError' && typeof error.code === 'string') {
    return error.code.slice(0, 120);
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,120}$/u.test(error.message)) {
    return error.message;
  }
  return 'OPENAI_LUNA_TERRA_BENCHMARK_FAILED';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
